import os from 'node:os';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { lightweightProfile } from '../codex/modelProfiles.js';
import type { RepoClassificationResult, WorkflowStepLogger } from '../types/contracts.js';

export interface RepoAffinity {
  /** Hits in the user's last 30 days for newton-web. */
  newtonWebHits?: number;
  /** Hits in the user's last 30 days for newton-api. */
  newtonApiHits?: number;
}

export interface ClassifyRepoParams {
  /** The user's current request — the message that triggered this classification. */
  task: string;
  /** Earlier messages in the same Slack thread, if any. Quoted as advisory context. */
  threadMessages?: string[];
  threshold: number;
  affinity?: RepoAffinity;
  /** Planner's affectedFiles — passed to the agent as advisory context, not pattern-matched. */
  planAffectedFiles?: string[];
  /**
   * Planner's full plan markdown. When provided, the classifier reads the
   * plan's own reasoning ("we'll modify X in newton-web because Y") rather
   * than guessing from filenames. Highest-signal input when available.
   */
  planMarkdown?: string;
  logStep?: WorkflowStepLogger;
}

const CLASSIFY_PROMPT = `You are a repo classifier for miniOG, a developer productivity bot.

The user has sent a task. Route it to one of two repositories:

- "newton-web" — the frontend repo (React + TypeScript). Owns the customer-facing web app at my.newtonschool.co and other newtonschool.co properties. Owns everything visible in the browser: pages, components, nav bars, sidebars, banners, sections, modals, dialogs, buttons, filters, layouts, navigation, CSS, mobile/desktop styling, Next.js / Vite hydration issues, anything tied to a URL the user can open.

- "newton-api" — the backend repo (Python + Django). Owns HTTP endpoints, request handlers, serializers, models, migrations, Celery tasks, Postgres queries, server-side business logic, integrations with third-party APIs, background jobs, and HTTP 5xx errors.

Repo signals you can use beyond intent:

- newton-web (React) file patterns:
  • directories: \`src/containers/\`, \`src/components/\`, \`src/hooks/\`, \`src/utils/\`, \`src/tracking/\`, \`src/pages/\`
  • extensions: \`.tsx\`, \`.jsx\`, \`.ts\`, \`.js\`, \`.styles.js\`, \`.styles.ts\`
  • keywords inside the plan: \`useState\`, \`useEffect\`, \`useSelector\`, \`useDispatch\`, \`styled-components\`, \`NSTypography\`, \`NSButton\`, \`NSIcon\`, \`@newtonschool/grauity\`, \`useNsatTimelineData\`, \`useSendAnalyticsEvent\`
- newton-api (Django) file patterns:
  • directories: \`courses/\`, \`users/\`, \`payments/\`, \`migrations/\`, \`management/commands/\`
  • files: \`models.py\`, \`views.py\`, \`serializers.py\`, \`enums.py\`, \`urls.py\`, \`tasks.py\`, \`signals.py\`, \`apps.py\`
  • keywords: \`Model\`, \`Serializer\`, \`ViewSet\`, \`APIView\`, \`Celery\`, \`@receiver\`, \`migrations.RunPython\`, \`PreferredCampus enum\`

Rules:
- A task that asks to add, remove, hide, or restyle something visible on a URL is almost always "newton-web".
- A task about an endpoint, request/response shape, server error, database/model change, or background job is "newton-api".
- A task that needs both: pick the repo where the BULK of the change lives. Cross-repo references (e.g. a frontend plan citing a backend enum for context) DO NOT flip the verdict — the repo with the actual code changes wins.
- If a plan markdown is provided, trust the plan's own per-file rationale over a raw filename. The planner already explored the repos.
- The current task always wins over thread context. Thread messages are quoted for background only.
- Only return null if you genuinely cannot tell after considering all signals. Aim for a decisive verdict — ambiguous output makes the bot stall for an admin gate.

Return strict JSON:
{
  "selectedRepo": "newton-web" | "newton-api" | null,
  "confidence": number between 0 and 1,
  "reasoning": "one short sentence"
}`;

const FALLBACK: RepoClassificationResult = {
  selectedRepo: null,
  confidence: 0,
  reasoning: 'Classifier call failed — deferring to admin.',
  uncertain: true,
};

export async function classifyRepo(params: ClassifyRepoParams): Promise<RepoClassificationResult> {
  const { task, threadMessages, threshold, affinity, planAffectedFiles, planMarkdown, logStep } = params;

  const trimmedTask = typeof task === 'string' ? task.trim() : '';
  if (!trimmedTask) {
    logStep?.({
      stage: 'router.repo_classify.skip',
      message: 'No task text to classify — deferring to admin.',
      level: 'WARN',
    });
    return { ...FALLBACK, reasoning: 'No task text to classify.' };
  }

  const cleanThread = (threadMessages ?? [])
    .filter(m => typeof m === 'string' && m.trim().length > 0)
    .map(m => m.trim());

  const sections: string[] = [`Current task (the message to classify):\n"""\n${trimmedTask}\n"""`];
  if (cleanThread.length > 0) {
    const numbered = cleanThread.map((m, i) => `[${i + 1}] ${m}`).join('\n');
    sections.push(`Earlier thread messages (advisory background, do not classify on these alone):\n${numbered}`);
  }
  if (planAffectedFiles && planAffectedFiles.length > 0) {
    sections.push(`Planner's affected files (advisory):\n${planAffectedFiles.join('\n')}`);
  }
  if (typeof planMarkdown === 'string' && planMarkdown.trim().length > 0) {
    // Truncate to a generous but bounded slice — full plans can be tens of
    // KB on large features. The first ~4k chars cover the intent, file
    // table, and rationale; the implementation-steps tail rarely adds new
    // repo signal beyond what the file table already carried.
    const MAX_PLAN_CHARS = 4000;
    const truncated =
      planMarkdown.length > MAX_PLAN_CHARS ? `${planMarkdown.slice(0, MAX_PLAN_CHARS)}…[truncated]` : planMarkdown;
    sections.push(
      `Planner's full plan markdown (HIGH-SIGNAL — the plan's own per-file rationale is the most trustworthy signal):\n${truncated}`,
    );
  }
  if (affinity && ((affinity.newtonWebHits ?? 0) > 0 || (affinity.newtonApiHits ?? 0) > 0)) {
    sections.push(
      `Requester's recent activity (advisory — current task wins over priors): ` +
        `newton-web=${affinity.newtonWebHits ?? 0} hits, newton-api=${affinity.newtonApiHits ?? 0} hits`,
    );
  }

  const prompt = `${CLASSIFY_PROMPT}\n\n${sections.join('\n\n')}\n\nClassify the current task.`;

  logStep?.({
    stage: 'router.repo_classify.start',
    message: 'Running AI repo classifier.',
    data: {
      planHints: planAffectedFiles?.length ?? 0,
      hasAffinity: Boolean(affinity && ((affinity.newtonWebHits ?? 0) > 0 || (affinity.newtonApiHits ?? 0) > 0)),
    },
  });

  try {
    const profile = lightweightProfile(getActiveBackendId());
    const result = await runCodex({
      cwd: os.tmpdir(),
      prompt,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      timeoutMs: 30_000,
    });

    if (!result.ok || !result.parsedJson) {
      logStep?.({
        stage: 'router.repo_classify.fallback',
        message: 'Repo classifier call failed — treating as uncertain.',
        level: 'WARN',
        data: { ok: result.ok, exitCode: result.exitCode, parsedJson: Boolean(result.parsedJson) },
      });
      return FALLBACK;
    }

    const raw = result.parsedJson as {
      selectedRepo?: string | null;
      confidence?: number;
      reasoning?: string;
    };
    const selectedRepo: 'newton-web' | 'newton-api' | null =
      raw.selectedRepo === 'newton-web' || raw.selectedRepo === 'newton-api' ? raw.selectedRepo : null;
    const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0;
    const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning : '';
    const uncertain = !selectedRepo || confidence < threshold;

    const classification: RepoClassificationResult = { selectedRepo, confidence, reasoning, uncertain };

    logStep?.({
      stage: 'router.repo_classify.done',
      message: `Classified repo as ${selectedRepo ?? 'null'} (confidence=${confidence.toFixed(2)}).`,
      data: { ...classification },
    });

    return classification;
  } catch (error) {
    logStep?.({
      stage: 'router.repo_classify.error',
      message: `Repo classifier threw: ${String(error)} — treating as uncertain.`,
      level: 'WARN',
    });
    return FALLBACK;
  }
}
