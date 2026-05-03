import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunResult,
  NormalizedTask,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { assembleRecall } from '../codex/recallAssembler.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { githubAuthModeHint } from '../github/githubAuth.js';
import { prepareWorkflowContext, extractReplyFromCodexResult } from './shared/workflowUtils.js';
import { resolveWatchtowerPath, buildLiveStateSnapshot } from './shared/selfInquiryContext.js';
import type { RecallCapableStore } from '../state/dossierStore.js';
import type { JobStore } from '../state/jobStore.js';

type RepoName = 'newton-web' | 'newton-api' | 'miniog-self';
type Target = { repo: RepoName; cwd: string };

type PromptContext = {
  threadContext: string;
  imageContext: string;
  githubToken?: string;
};

type PerRepoOutcome =
  | { repo: RepoName; kind: 'answer'; text: string }
  | { repo: RepoName; kind: 'not_applicable'; reason: string }
  | { repo: RepoName; kind: 'failure'; reason: string };

const NOT_APPLICABLE_PREFIX = 'NOT_APPLICABLE:';
const FALLBACK_MESSAGE = 'I could not find a clear answer. Try rephrasing your question.';

export async function runInformationalWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: RecallCapableStore;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, logStep, signal } = params;

  logStep?.({
    stage: 'informational.start',
    message: 'Running informational workflow.',
  });

  // Informational queries search both Newton repos in parallel — skip the
  // repo-clarify gate that prepareWorkflowContext would otherwise fire.
  const ctx = await prepareWorkflowContext({ task, config, slack, logStep, resolveRepo: false });

  // Assemble the recall block once (Phase G). Prepended to every per-repo
  // prompt below — including the self-inquiry path — so the model sees the
  // user's pinned facts and recent work alongside the question. Empty when
  // the user has no dossier; safe to thread unconditionally.
  let recallBlock = '';
  if (store?.dossierStore && store.recentSignalsForUser && task.event.userId) {
    try {
      const recall = await assembleRecall({
        userId: task.event.userId,
        workflow: 'INFORMATIONAL',
        store: store as unknown as JobStore,
        vaultRoot: store.readVaultSettings?.().vaultPath ?? null,
      });
      if (recall.promptBlock) {
        recallBlock = `${recall.promptBlock}\n\n`;
        logStep?.({
          stage: 'workflow.recall.injected',
          message: `Injected recall (${recall.estimatedTokens} tokens, ${recall.sources.join(',')}).`,
          data: { sources: recall.sources, estimatedTokens: recall.estimatedTokens, workflow: 'INFORMATIONAL' },
        });
      }
    } catch (err) {
      logStep?.({
        stage: 'workflow.recall.failed',
        level: 'WARN',
        message: 'recall assembly failed; running without it',
        data: { error: (err as Error).message, workflow: 'INFORMATIONAL' },
      });
    }
  }

  const promptCtx: PromptContext = {
    threadContext: ctx.threadContext,
    imageContext: ctx.imageContext,
    githubToken: ctx.githubToken,
  };

  const targets: Target[] = [];
  if (config.repoPaths.newtonWeb) targets.push({ repo: 'newton-web', cwd: config.repoPaths.newtonWeb });
  if (config.repoPaths.newtonApi) targets.push({ repo: 'newton-api', cwd: config.repoPaths.newtonApi });

  const selfPath = await resolveWatchtowerPath(config);
  if (selfPath) {
    targets.push({ repo: 'miniog-self', cwd: selfPath });
  } else {
    logStep?.({
      stage: 'informational.self.skipped',
      level: 'WARN',
      message: 'Watchtower self-inquiry target not resolved; bot-about-itself questions will fall through.',
    });
  }

  const selfSnapshot = selfPath ? await buildLiveStateSnapshot(config) : undefined;

  let reply: string;
  let ok: boolean;

  if (targets.length === 0) {
    const single = await runSingleUnscoped({ ctx, task, promptCtx, recallBlock, logStep, signal });
    reply = single.reply;
    ok = single.ok;
  } else {
    const outcomes = await runFanout({ targets, task, promptCtx, recallBlock, selfSnapshot, logStep, signal });
    const synth = synthesizeInformationalReplies(outcomes);
    reply = synth.reply;
    ok = synth.ok;

    logStep?.({
      stage: 'informational.synthesize.done',
      message: 'Combined per-repo findings into a single reply.',
      data: {
        includedRepos: outcomes.filter(o => o.kind === 'answer').map(o => o.repo),
        replyLength: reply.length,
      },
    });
  }

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: reply,
  });

  logStep?.({
    stage: 'informational.done',
    message: 'Posted informational reply.',
  });

  return {
    workflow: 'INFORMATIONAL',
    status: ok ? 'SUCCESS' : 'FAILED',
    message: reply,
    notifyDesktop: false,
    slackPosted: true,
  };
}

async function runSingleUnscoped(params: {
  ctx: { cwd: string; imagePaths: string[] } & PromptContext;
  task: NormalizedTask;
  promptCtx: PromptContext;
  recallBlock: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<{ reply: string; ok: boolean }> {
  const { ctx, task, promptCtx, recallBlock, logStep, signal } = params;

  const prompt = `${recallBlock}${buildUnscopedPrompt({ cwd: ctx.cwd, task, promptCtx })}`;

  const result = await runCodex({
    cwd: ctx.cwd,
    prompt,
    githubToken: ctx.githubToken,
    imagePaths: ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
    ...highReasoningProfile(getActiveBackendId()),
    onLog: logStep,
    signal,
  });

  logStep?.({
    stage: 'informational.codex.done',
    message: 'Informational codex execution finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: { ok: result.ok, exitCode: result.exitCode },
  });

  const reply = extractReplyFromCodexResult(result) || FALLBACK_MESSAGE;
  return { reply, ok: result.ok };
}

async function runFanout(params: {
  targets: Target[];
  task: NormalizedTask;
  promptCtx: PromptContext;
  recallBlock: string;
  selfSnapshot?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<PerRepoOutcome[]> {
  const { targets, task, promptCtx, recallBlock, selfSnapshot, logStep, signal } = params;

  logStep?.({
    stage: 'informational.fanout.start',
    message: `Searching ${targets.length} repo(s) in parallel.`,
    data: { targets: targets.map(t => t.repo) },
  });

  const settled = await Promise.allSettled(
    targets.map(target =>
      runCodex({
        cwd: target.cwd,
        prompt: `${recallBlock}${
          target.repo === 'miniog-self'
            ? buildSelfInquiryPrompt({ target, task, promptCtx, snapshot: selfSnapshot ?? '' })
            : buildScopedPrompt({ target, task, promptCtx })
        }`,
        githubToken: promptCtx.githubToken,
        ...highReasoningProfile(getActiveBackendId()),
        onLog: logStep,
        signal,
      }),
    ),
  );

  return settled.map((settledResult, i) => {
    const target = targets[i];
    const outcome = classifyPerRepoOutcome(target, settledResult);
    logStep?.({
      stage: `informational.fanout.${shortRepo(target.repo)}.done`,
      message: `Finished searching ${target.repo}.`,
      level: outcome.kind === 'failure' ? 'WARN' : 'INFO',
      data: {
        ok: outcome.kind === 'answer',
        kind: outcome.kind,
        exitCode: settledResult.status === 'fulfilled' ? settledResult.value.exitCode : undefined,
      },
    });
    return outcome;
  });
}

function classifyPerRepoOutcome(target: Target, settled: PromiseSettledResult<CodexRunResult>): PerRepoOutcome {
  if (settled.status === 'rejected') {
    return { repo: target.repo, kind: 'failure', reason: String(settled.reason) };
  }
  const result = settled.value;
  if (!result.ok) {
    return { repo: target.repo, kind: 'failure', reason: `exit ${result.exitCode}` };
  }
  const text = (extractReplyFromCodexResult(result) || '').trim();
  if (!text) {
    return { repo: target.repo, kind: 'failure', reason: 'empty response' };
  }
  if (text.startsWith(NOT_APPLICABLE_PREFIX)) {
    const reason = text.slice(NOT_APPLICABLE_PREFIX.length).trim() || 'not applicable';
    return { repo: target.repo, kind: 'not_applicable', reason };
  }
  return { repo: target.repo, kind: 'answer', text };
}

export function synthesizeInformationalReplies(outcomes: PerRepoOutcome[]): { reply: string; ok: boolean } {
  const answers = outcomes.filter((o): o is Extract<PerRepoOutcome, { kind: 'answer' }> => o.kind === 'answer');

  if (answers.length === 0) {
    const allNotApplicable = outcomes.length > 0 && outcomes.every(o => o.kind === 'not_applicable');
    if (allNotApplicable) {
      const scope = outcomes.map(o => repoLabel(o.repo)).join(', ');
      return {
        reply: `That question doesn't seem to map to anything I can search (${scope}). Try rephrasing or pointing me at a specific area.`,
        ok: false,
      };
    }
    return { reply: FALLBACK_MESSAGE, ok: false };
  }

  if (answers.length === 1) {
    const only = answers[0];
    const otherFailed = outcomes.find(
      (o): o is Extract<PerRepoOutcome, { kind: 'failure' }> => o.repo !== only.repo && o.kind === 'failure',
    );
    if (otherFailed) {
      const note = `_Could not search ${otherFailed.repo} (${otherFailed.reason}). Results below cover ${only.repo} only._`;
      return { reply: `${note}\n\n${only.text}`, ok: true };
    }
    return { reply: only.text, ok: true };
  }

  const sections: string[] = [];
  for (const repo of ['newton-web', 'newton-api', 'miniog-self'] as RepoName[]) {
    const ans = answers.find(a => a.repo === repo);
    if (!ans) continue;
    sections.push(`*${repoLabel(repo)}:*\n${ans.text}`);
  }
  return { reply: sections.join('\n\n'), ok: true };
}

function buildUnscopedPrompt(params: { cwd: string; task: NormalizedTask; promptCtx: PromptContext }): string {
  const { cwd, task, promptCtx } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'INFORMATIONAL', toneMode: task.toneMode })}

Context:
- You are miniOG, a developer assistant bot in a Slack workspace.
- The user @mentioned you in a Slack thread asking a question about the codebase.
- Your response will be posted DIRECTLY into that Slack thread as-is. No transformation, no wrapping — what you write is exactly what the user sees.
- You have READ-ONLY access to the codebase at: ${cwd}
- GitHub auth mode: ${githubAuthModeHint(Boolean(promptCtx.githubToken))}

Instructions:
- Answer the user's question thoroughly but concisely.
- You can read files, search code, and explain things. Do NOT modify any files, create branches, or make commits.
- Write your response as a ready-to-post Slack message.
- Use Slack markdown for formatting (*bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`, bullet lists).
- If you reference code, quote the relevant parts inline.

Slack thread context:
${promptCtx.threadContext}${promptCtx.imageContext}
`.trim();
}

function buildScopedPrompt(params: { target: Target; task: NormalizedTask; promptCtx: PromptContext }): string {
  const { target, task, promptCtx } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'INFORMATIONAL', toneMode: task.toneMode })}

Context:
- You are miniOG, a developer assistant bot in a Slack workspace.
- The user @mentioned you in a Slack thread asking a question about the Newton codebase.
- Your response may be combined with a sibling agent's answer from the other Newton repo before reaching the user.
- You have READ-ONLY access to ONE repo at: ${target.cwd}
- GitHub auth mode: ${githubAuthModeHint(Boolean(promptCtx.githubToken))}

Scope for this run:
- You are searching ONLY the ${target.repo} repository at ${target.cwd}.
- A sibling agent is covering the other Newton repo in parallel — do not speculate about it or reference it.
- If the user's question has no meaningful connection to this repo, respond with exactly:
    ${NOT_APPLICABLE_PREFIX} <one short reason>
  and nothing else. Do not guess.
- Otherwise, return findings grounded in THIS repo's code (file paths, function names, code quotes).

Instructions:
- Answer the user's question thoroughly but concisely.
- You can read files, search code, and explain things. Do NOT modify any files, create branches, or make commits.
- Use Slack markdown for formatting (*bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`, bullet lists).
- Do NOT add a header like "Frontend:" or "Backend:" — the caller adds section headers if needed.
- If you reference code, quote the relevant parts inline.

Slack thread context:
${promptCtx.threadContext}${promptCtx.imageContext}
`.trim();
}

function shortRepo(repo: RepoName): 'web' | 'api' | 'self' {
  if (repo === 'newton-web') return 'web';
  if (repo === 'newton-api') return 'api';
  return 'self';
}

function repoLabel(repo: RepoName): string {
  if (repo === 'newton-web') return 'Frontend (newton-web)';
  if (repo === 'newton-api') return 'Backend (newton-api)';
  return 'Bot internals (miniOG)';
}

function buildSelfInquiryPrompt(params: {
  target: Target;
  task: NormalizedTask;
  promptCtx: PromptContext;
  snapshot: string;
}): string {
  const { target, task, promptCtx, snapshot } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'INFORMATIONAL', toneMode: task.toneMode })}

Context:
- You are miniOG, a developer assistant bot in a Slack workspace.
- The user @mentioned you in a Slack thread asking a question that may be about miniOG / Watchtower **itself** — its capabilities, configuration, MCP integrations, supported backends, permission model, behavior, or runtime state.
- Sibling agents are searching the Newton product repos in parallel — you are responsible only for questions about the bot itself.
- You have READ-ONLY access to the watchtower source at: ${target.cwd}
- GitHub auth mode: ${githubAuthModeHint(Boolean(promptCtx.githubToken))}

Scope for this run:
- If the user's question is NOT about miniOG/Watchtower itself (e.g. it asks about the Newton product code, a PR, or business logic), respond with exactly:
    ${NOT_APPLICABLE_PREFIX} <one short reason>
  and nothing else. Do not guess.
- Otherwise, answer authoritatively using:
    1. The live state snapshot below (runtime facts not derivable from source).
    2. The watchtower source at ${target.cwd} (read code, configs, package.json, README, AGENTS.md, etc.).
- Cross-check the snapshot against the source when it matters (e.g. for "is X MCP configured", confirm against \`~/.claude.json\` and the codebase before claiming).
- Do NOT add a header like "Bot internals:" — the caller adds section headers if needed.

${snapshot}

Instructions:
- Answer the user's question thoroughly but concisely.
- You can read files, search code, and explain things. Do NOT modify any files, create branches, or make commits.
- Use Slack markdown for formatting (*bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`, bullet lists).
- If you reference code, quote the relevant parts inline.

Slack thread context:
${promptCtx.threadContext}${promptCtx.imageContext}
`.trim();
}
