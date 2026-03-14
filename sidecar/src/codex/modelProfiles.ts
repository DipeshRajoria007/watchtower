import type { CodexReasoningEffort } from '../types/contracts.js';
import type { AgentRole } from '../agents/types.js';
import type { AgentBackendId } from '../backends/types.js';

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

type BackendProfileTable = Record<'lightweight' | 'highReasoning', CodexExecutionProfile>;

const BACKEND_PROFILES: Record<AgentBackendId, BackendProfileTable> = {
  codex: {
    lightweight: LIGHTWEIGHT_CODEX_PROFILE,
    highReasoning: HIGH_REASONING_CODEX_PROFILE,
  },
  'claude-code': {
    lightweight: {
      model: 'claude-sonnet-4-20250514',
      reasoningEffort: 'low',
    },
    highReasoning: {
      model: 'claude-opus-4-20250514',
      reasoningEffort: 'high',
    },
  },
  cursor: {
    lightweight: {
      model: 'claude-sonnet-4-20250514',
      reasoningEffort: 'low',
    },
    highReasoning: {
      model: 'claude-sonnet-4-20250514',
      reasoningEffort: 'high',
    },
  },
};

const ROLE_TIER: Record<AgentRole, 'lightweight' | 'highReasoning'> = {
  planner: 'lightweight',
  coder: 'highReasoning',
  reviewer: 'highReasoning',
  security: 'highReasoning',
  performance: 'lightweight',
  verifier: 'lightweight',
};

export function profileForAgentRole(role: AgentRole, backendId?: AgentBackendId): CodexExecutionProfile {
  const backend = backendId ?? 'codex';
  const tier = ROLE_TIER[role];
  return BACKEND_PROFILES[backend][tier];
}

export function highReasoningProfile(backendId: AgentBackendId): CodexExecutionProfile {
  return BACKEND_PROFILES[backendId].highReasoning;
}

export function lightweightProfile(backendId: AgentBackendId): CodexExecutionProfile {
  return BACKEND_PROFILES[backendId].lightweight;
}
