import type { AgentBackendId, CodexRunRequest, CodexRunResult, TokenUsage } from '../types/contracts.js';

export type { AgentBackendId };

export type AgentRunRequest = CodexRunRequest;
export type AgentRunResult = CodexRunResult;

export interface ParsedBackendOutput {
  parsedJson?: Record<string, unknown>;
  strategy?: string;
  usage?: TokenUsage;
  costUsd?: number;
}

export interface AgentBackend {
  id: AgentBackendId;
  displayName: string;
  resolveBinary(): string;
  isAvailable(): boolean;
  supportsImages(): boolean;
  buildArgs(request: AgentRunRequest, outputPath: string): string[];
  buildEnv(request: AgentRunRequest, basePath: string): Record<string, string>;
  parseOutput(raw: string): ParsedBackendOutput;
  availableModels(): string[];
  defaultModel(): string;
}
