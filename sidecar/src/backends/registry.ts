import type { AgentBackend, AgentBackendId } from './types.js';
import { codexBackend } from './codexBackend.js';
import { claudeCodeBackend } from './claudeCodeBackend.js';
import { cursorBackend } from './cursorBackend.js';

const BACKENDS: Record<AgentBackendId, AgentBackend> = {
  codex: codexBackend,
  'claude-code': claudeCodeBackend,
  cursor: cursorBackend,
};

export function getBackend(id: AgentBackendId): AgentBackend {
  const backend = BACKENDS[id];
  if (!backend) {
    throw new Error(`Unknown agent backend: ${id}`);
  }
  return backend;
}

export function listBackends(): AgentBackend[] {
  return Object.values(BACKENDS);
}

export function listAvailableBackends(): AgentBackend[] {
  return Object.values(BACKENDS).filter(backend => backend.isAvailable());
}
