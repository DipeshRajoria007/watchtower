import type { CodexReasoningEffort } from '../types/contracts.js';

type CodexExecutionProfile = {
  model: string;
  reasoningEffort: CodexReasoningEffort;
};

function readOverride(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export const LIGHTWEIGHT_CODEX_PROFILE: CodexExecutionProfile = {
  model: readOverride('WATCHTOWER_LIGHTWEIGHT_CODEX_MODEL') ?? 'gpt-5.2-codex',
  reasoningEffort: 'low',
};

export const HIGH_REASONING_CODEX_PROFILE: CodexExecutionProfile = {
  model: readOverride('WATCHTOWER_HIGH_REASONING_CODEX_MODEL') ?? 'gpt-5.4',
  reasoningEffort: 'xhigh',
};
