import os from 'node:os';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { lightweightProfile } from '../codex/modelProfiles.js';
import type { WorkflowIntent, WorkflowStepLogger } from '../types/contracts.js';

export interface IntentClassification {
  intent: WorkflowIntent;
  confidence: number;
  reasoning: string;
}

const CLASSIFY_PROMPT = `You are a workflow intent classifier for a developer productivity bot. Your ONLY job is to classify what workflow should handle the user's message.

You have NO access to any codebase. Classify based purely on the user's message and thread context.

Available workflows:
- PR_REVIEW: The user wants a code review of a GitHub pull request. Signals: they link a PR URL, ask to "review" code changes, request feedback on a pull request, or paste a GitHub PR link with an implicit request to look at it.
- OWNER_AUTOPILOT: The user wants something done — implement a feature, fix a bug, answer a question, chat, or any other general request that is NOT specifically about reviewing a PR.

Classification rules:
- If the message contains a GitHub PR URL (github.com/.../pull/...) AND the user's intent is to get that PR reviewed, analyzed, or get feedback on it → PR_REVIEW
- If the message contains a GitHub PR URL but the user is asking to CREATE a PR, FIX something in the PR, or just referencing it casually (e.g. "give me the PR link", "merge this PR", "what's the status of the PR") → OWNER_AUTOPILOT
- If there is no GitHub PR URL at all → OWNER_AUTOPILOT (a PR review requires a PR link)
- Questions, implementation requests, bug fixes, greetings, casual chat → OWNER_AUTOPILOT

Return strict JSON:
{
  "intent": "PR_REVIEW" | "OWNER_AUTOPILOT",
  "confidence": number between 0 and 1,
  "reasoning": "one sentence explaining why"
}`;

function buildClassifyUserPrompt(params: { userMessage: string; threadContext?: string; hasPrUrl: boolean }): string {
  const lines = [`User message: "${params.userMessage}"`];
  lines.push(`Contains GitHub PR URL: ${params.hasPrUrl}`);
  if (params.threadContext) {
    lines.push(`\nThread context:\n${params.threadContext}`);
  }
  lines.push('\nClassify this message.');
  return lines.join('\n');
}

const SAFE_FALLBACK: IntentClassification = {
  intent: 'OWNER_AUTOPILOT',
  confidence: 0.5,
  reasoning: 'Classification failed — defaulting to OWNER_AUTOPILOT as the general-purpose workflow.',
};

export async function classifyWorkflowIntent(params: {
  userMessage: string;
  threadContext?: string;
  hasPrUrl: boolean;
  logStep?: WorkflowStepLogger;
}): Promise<IntentClassification> {
  const { userMessage, threadContext, hasPrUrl, logStep } = params;

  logStep?.({
    stage: 'router.classify.start',
    message: 'Running AI-based workflow intent classification.',
    data: { userMessage, hasPrUrl },
  });

  try {
    const fullPrompt = `${CLASSIFY_PROMPT}\n\n${buildClassifyUserPrompt({ userMessage, threadContext, hasPrUrl })}`;
    const profile = lightweightProfile(getActiveBackendId());

    const result = await runCodex({
      cwd: os.tmpdir(),
      prompt: fullPrompt,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      timeoutMs: 30_000,
    });

    if (!result.ok || !result.parsedJson) {
      logStep?.({
        stage: 'router.classify.fallback',
        message: 'Classification AI call failed or returned non-JSON — using OWNER_AUTOPILOT fallback.',
        level: 'WARN',
        data: {
          ok: result.ok,
          exitCode: result.exitCode,
          parsedJson: Boolean(result.parsedJson),
        },
      });
      return SAFE_FALLBACK;
    }

    const raw = result.parsedJson;
    const validIntents: WorkflowIntent[] = ['PR_REVIEW', 'OWNER_AUTOPILOT'];
    const intent = validIntents.includes(raw.intent as WorkflowIntent)
      ? (raw.intent as WorkflowIntent)
      : 'OWNER_AUTOPILOT';

    const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.5;
    const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning : '';

    const classification: IntentClassification = { intent, confidence, reasoning };

    logStep?.({
      stage: 'router.classify.done',
      message: `Classified workflow intent as ${intent} (confidence=${confidence.toFixed(2)}).`,
      data: { ...classification },
    });

    return classification;
  } catch (error) {
    logStep?.({
      stage: 'router.classify.error',
      message: `Classification threw unexpectedly — using OWNER_AUTOPILOT fallback: ${String(error)}`,
      level: 'WARN',
    });
    return SAFE_FALLBACK;
  }
}
