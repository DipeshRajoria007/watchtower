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
- IMPLEMENTATION: The user wants something built, changed, fixed, added, removed, or modified. Keywords like "I want to", "add", "implement", "fix", "block", "create", "change", "update", "remove", "build", "make", "write", "refactor", "migrate", "set up", "configure", "enable", "disable" all indicate implementation intent — even if the feature already exists somewhere.
- INFORMATIONAL: The user is asking a question, wants an explanation, or wants to understand something. Keywords like "how does", "what is", "explain", "describe", "list", "show me", "where is", "why does", "check status", "tell me about", "can you explain".
- CONVERSATIONAL: Greetings, banter, presence checks, casual chat, thanks. Keywords like "hi", "hello", "thanks", "how are you", "you there", "good morning", "what's up".

Classification rules:
- If the message contains a GitHub PR URL (github.com/.../pull/...) AND the user's intent is to get that PR reviewed → PR_REVIEW
- If the message contains a GitHub PR URL but the user is asking to CREATE, FIX, or MERGE a PR → IMPLEMENTATION
- If there is no GitHub PR URL and the user asks to build/change/fix something → IMPLEMENTATION
- If the user asks a question or wants to understand something → INFORMATIONAL
- If the user is just chatting, greeting, or thanking → CONVERSATIONAL
- If the user says they want something done, that is ALWAYS IMPLEMENTATION regardless of whether it might already exist. The user's explicit request takes absolute priority.
- When in doubt between IMPLEMENTATION and INFORMATIONAL, prefer IMPLEMENTATION (safer to run the full pipeline than skip a real request).

Return strict JSON:
{
  "intent": "PR_REVIEW" | "IMPLEMENTATION" | "INFORMATIONAL" | "CONVERSATIONAL",
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
  intent: 'IMPLEMENTATION',
  confidence: 0.5,
  reasoning: 'Classification failed — defaulting to IMPLEMENTATION to avoid skipping a real request.',
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
        message: 'Classification AI call failed — using IMPLEMENTATION fallback.',
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
    const validIntents: WorkflowIntent[] = ['PR_REVIEW', 'IMPLEMENTATION', 'INFORMATIONAL', 'CONVERSATIONAL'];
    const intent = validIntents.includes(raw.intent as WorkflowIntent)
      ? (raw.intent as WorkflowIntent)
      : 'IMPLEMENTATION';

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
      message: `Classification threw unexpectedly — using IMPLEMENTATION fallback: ${String(error)}`,
      level: 'WARN',
    });
    return SAFE_FALLBACK;
  }
}
