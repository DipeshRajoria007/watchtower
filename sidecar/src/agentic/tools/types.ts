import type { z } from 'zod';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, Capability, NormalizedTask } from '../../types/contracts.js';
import type { JobStore } from '../../state/jobStore.js';
import type { WorkflowStepLogger } from '../../types/contracts.js';

/**
 * Runtime context every tool gets when invoked. Carries the caller's identity,
 * the Slack client for posting replies, the job store for persistence, and a
 * log function. The agent itself doesn't see this — it's injected by the
 * runner between the LLM's tool-call request and the tool function body.
 */
export interface ToolContext {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store: JobStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}

/**
 * Result a tool returns to the agent. The agent sees `content` as a string
 * (rendered into the tool_result message back to the LLM). `terminal: true`
 * tells the runner the agent should stop after this tool call (used by
 * `post_slack_reply` — once it posts, the loop ends).
 */
export interface ToolResult {
  content: string;
  isError?: boolean;
  terminal?: boolean;
  /** Optional structured data captured into job_logs for telemetry. */
  data?: Record<string, unknown>;
}

/**
 * Tool definition. `name` and `description` map directly to the Anthropic
 * tool-use API. `inputSchema` validates the model's args before the
 * handler runs (defense in depth — the model can hallucinate arg shapes).
 * `capability` is the capability gate; the runner filters tools by what
 * the caller can access BEFORE registering them with the model, so the
 * agent never sees tools it can't call.
 */
export interface ToolDefinition<T extends z.ZodType> {
  name: string;
  description: string;
  capability: Capability;
  inputSchema: T;
  /** Anthropic-format input schema (JSON Schema). Derived from inputSchema. */
  inputJsonSchema: Record<string, unknown>;
  handler: (args: z.output<T>, context: ToolContext) => Promise<ToolResult>;
}

/** Bundle of tools available to a single agent run. */
export interface ToolSurface {
  tools: ToolDefinition<z.ZodType>[];
  /** Indexed by name for O(1) dispatch. */
  byName: Map<string, ToolDefinition<z.ZodType>>;
}
