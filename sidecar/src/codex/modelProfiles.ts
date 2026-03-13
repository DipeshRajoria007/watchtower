import type { CodexReasoningEffort } from '../types/contracts.js';
import type { AgentRole } from '../agents/types.js';

export type CodexExecutionProfile = {
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

const AGENT_ROLE_PROFILES: Record<AgentRole, CodexExecutionProfile> = {
  planner: LIGHTWEIGHT_CODEX_PROFILE,
  coder: HIGH_REASONING_CODEX_PROFILE,
  reviewer: HIGH_REASONING_CODEX_PROFILE,
  security: HIGH_REASONING_CODEX_PROFILE,
  performance: LIGHTWEIGHT_CODEX_PROFILE,
  verifier: LIGHTWEIGHT_CODEX_PROFILE,
};

export function profileForAgentRole(role: AgentRole): CodexExecutionProfile {
  return AGENT_ROLE_PROFILES[role];
}
