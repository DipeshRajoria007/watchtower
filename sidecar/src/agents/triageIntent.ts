import os from 'node:os';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { lightweightProfile } from '../codex/modelProfiles.js';
import type { WorkflowStepLogger } from '../types/contracts.js';

export type TriageIntent = 'IMPLEMENTATION' | 'CONVERSATIONAL' | 'INFORMATIONAL';

export interface TriageResult {
  intent: TriageIntent;
  confidence: number;
  requiresCodeChanges: boolean;
  reasoning: string;
}

const TRIAGE_PROMPT = `You are an intent classifier. Your ONLY job is to classify what the user is asking for based on their message.

You have NO access to any codebase or repository. Classify based purely on what the user is requesting.

Classification rules:
- IMPLEMENTATION: The user wants something built, changed, fixed, added, removed, or modified. Keywords like "I want to", "add", "implement", "fix", "block", "create", "change", "update", "remove", "build", "make", "write", "refactor", "migrate", "set up", "configure", "enable", "disable" all indicate implementation intent — even if the feature already exists somewhere.
- INFORMATIONAL: The user is asking a question, wants an explanation, or wants to understand something. Keywords like "how does", "what is", "explain", "describe", "list", "show me", "where is", "why does", "check status".
- CONVERSATIONAL: Greetings, banter, presence checks, casual chat. Keywords like "hi", "hello", "thanks", "how are you", "you there".

IMPORTANT: If the user says they want something done, that is ALWAYS IMPLEMENTATION regardless of whether it might already exist. The user's explicit request takes absolute priority.

Return strict JSON:
{
  "intent": "IMPLEMENTATION" | "INFORMATIONAL" | "CONVERSATIONAL",
  "confidence": number between 0 and 1,
  "requiresCodeChanges": boolean,
  "reasoning": "one sentence explaining why"
}

requiresCodeChanges must be true when intent is IMPLEMENTATION, false otherwise.`;

function buildTriageUserPrompt(params: { userMessage: string; threadContext?: string }): string {
  const lines = [`User message: "${params.userMessage}"`];
  if (params.threadContext) {
    lines.push(`\nThread context (for understanding the conversation flow only):\n${params.threadContext}`);
  }
  lines.push('\nClassify this message.');
  return lines.join('\n');
}

const SAFE_FALLBACK: TriageResult = {
  intent: 'IMPLEMENTATION',
  confidence: 0.5,
  requiresCodeChanges: true,
  reasoning: 'Triage failed — defaulting to IMPLEMENTATION to avoid skipping a real request.',
};

export async function triageUserIntent(params: {
  userMessage: string;
  threadContext?: string;
  logStep?: WorkflowStepLogger;
}): Promise<TriageResult> {
  const { userMessage, threadContext, logStep } = params;

  logStep?.({
    stage: 'owner_autopilot.triage.start',
    message: 'Running AI-based intent triage before planner.',
    data: { userMessage },
  });

  try {
    const fullPrompt = `${TRIAGE_PROMPT}\n\n${buildTriageUserPrompt({ userMessage, threadContext })}`;
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
        stage: 'owner_autopilot.triage.fallback',
        message: 'Triage AI call failed or returned non-JSON — using safe IMPLEMENTATION fallback.',
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
    const intent = (['IMPLEMENTATION', 'CONVERSATIONAL', 'INFORMATIONAL'] as const).includes(raw.intent as TriageIntent)
      ? (raw.intent as TriageIntent)
      : 'IMPLEMENTATION';

    const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.5;
    const requiresCodeChanges = intent === 'IMPLEMENTATION';
    const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning : '';

    const triageResult: TriageResult = { intent, confidence, requiresCodeChanges, reasoning };

    logStep?.({
      stage: 'owner_autopilot.triage.done',
      message: `Triage classified intent as ${intent} (confidence=${confidence.toFixed(2)}).`,
      data: { ...triageResult },
    });

    return triageResult;
  } catch (error) {
    logStep?.({
      stage: 'owner_autopilot.triage.error',
      message: `Triage threw unexpectedly — using safe IMPLEMENTATION fallback: ${String(error)}`,
      level: 'WARN',
    });
    return SAFE_FALLBACK;
  }
}
