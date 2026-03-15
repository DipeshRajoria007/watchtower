import type { AgentBackendId, CodexRunRequest, CodexRunResult } from '../types/contracts.js';

export type { AgentBackendId };

export type AgentRunRequest = CodexRunRequest;
export type AgentRunResult = CodexRunResult;

export interface AgentBackend {
  id: AgentBackendId;
  displayName: string;
  resolveBinary(): string;
  isAvailable(): boolean;
  supportsImages(): boolean;
  buildArgs(request: AgentRunRequest, outputPath: string): string[];
  buildEnv(request: AgentRunRequest, basePath: string): Record<string, string>;
  parseOutput(raw: string): { parsedJson?: Record<string, unknown>; strategy?: string };
  availableModels(): string[];
  defaultModel(): string;
}
