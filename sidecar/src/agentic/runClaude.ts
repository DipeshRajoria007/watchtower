import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { ToolContext, ToolResult, ToolSurface } from './tools/types.js';
import type { WorkflowStepLogger } from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';

const MODEL_ID = process.env.WATCHTOWER_AGENTIC_MODEL ?? 'claude-opus-4-7';
const MAX_TOOL_CALLS_DEFAULT = 30;
const MAX_TOKENS = 4096;

export interface RunClaudeAgenticRequest {
  systemPrompt: string;
  userMessage: string;
  toolSurface: ToolSurface;
  toolContext: ToolContext;
  logStep?: WorkflowStepLogger;
  maxToolCalls?: number;
  signal?: AbortSignal;
  /** Optional job store + jobId; when present each Anthropic API call gets a row in `agent_calls` for cost dashboards. */
  store?: JobStore;
  jobId?: string;
  role?: string;
}

export interface RunClaudeAgenticResult {
  ok: boolean;
  reason: 'terminal_tool' | 'natural_end' | 'tool_cap' | 'error' | 'aborted';
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Final assistant text block when stop_reason is `end_turn` and no terminal tool fired. */
  finalText?: string;
  error?: string;
}

/**
 * Multi-turn agentic loop. Sends the user message + tool definitions to
 * Claude, executes tool calls the model requests, feeds results back, and
 * continues until either a terminal tool fires (e.g. post_slack_reply),
 * the model stops without calling a tool, or we hit the tool-call cap.
 *
 * The model itself never sees `ToolContext` — that's injected by us at
 * dispatch time so tools can't be tricked into operating on a different
 * channel/user/store than the caller.
 */
export async function runClaudeAgentic(request: RunClaudeAgenticRequest): Promise<RunClaudeAgenticResult> {
  const { systemPrompt, userMessage, toolSurface, toolContext, logStep, signal } = request;
  const maxToolCalls = request.maxToolCalls ?? MAX_TOOL_CALLS_DEFAULT;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      reason: 'error',
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      error: 'ANTHROPIC_API_KEY not set on sidecar process.',
    };
  }

  const client = new Anthropic({ apiKey });

  const anthropicTools = toolSurface.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputJsonSchema as Anthropic.Messages.Tool.InputSchema,
  }));

  const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: userMessage }];

  let toolCallCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (let iteration = 0; iteration < maxToolCalls + 5; iteration += 1) {
    if (signal?.aborted) {
      return {
        ok: false,
        reason: 'aborted',
        toolCallCount,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      };
    }

    let response: Anthropic.Messages.Message;
    const callStartedAt = Date.now();
    try {
      response = await client.messages.create({
        model: MODEL_ID,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      });
    } catch (err) {
      if (request.store && request.jobId) {
        try {
          request.store.recordAgentCall({
            jobId: request.jobId,
            role: request.role ?? 'agentic',
            backend: 'claude-code',
            model: MODEL_ID,
            durationMs: Date.now() - callStartedAt,
            ok: false,
          });
        } catch {
          // recording is best-effort
        }
      }
      logStep?.({
        stage: 'agentic.api_error',
        level: 'ERROR',
        message: `Anthropic API call failed: ${String(err)}`,
        data: { iteration },
      });
      return {
        ok: false,
        reason: 'error',
        toolCallCount,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        error: String(err),
      };
    }

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    cacheCreationTokens += response.usage.cache_creation_input_tokens ?? 0;

    if (request.store && request.jobId) {
      try {
        request.store.recordAgentCall({
          jobId: request.jobId,
          role: request.role ?? 'agentic',
          backend: 'claude-code',
          model: MODEL_ID,
          durationMs: Date.now() - callStartedAt,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? undefined,
          cacheCreationTokens: response.usage.cache_creation_input_tokens ?? undefined,
          ok: true,
        });
      } catch {
        // recording is best-effort
      }
    }

    const toolUses = response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use',
    );
    const textBlocks = response.content.filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text');

    if (response.stop_reason === 'end_turn' && toolUses.length === 0) {
      logStep?.({
        stage: 'agentic.end_turn_no_tool',
        message: 'Agent finished without calling a terminal tool.',
        level: 'WARN',
        data: {
          iteration,
          finalText: textBlocks
            .map(b => b.text)
            .join('\n')
            .slice(0, 500),
        },
      });
      return {
        ok: true,
        reason: 'natural_end',
        toolCallCount,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        finalText: textBlocks.map(b => b.text).join('\n'),
      };
    }

    if (toolUses.length === 0) {
      // No tool calls, no end_turn — should be rare. Treat as natural end.
      return {
        ok: true,
        reason: 'natural_end',
        toolCallCount,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        finalText: textBlocks.map(b => b.text).join('\n'),
      };
    }

    // Add the assistant's tool_use response to the message history.
    messages.push({ role: 'assistant', content: response.content });

    // Execute each tool call in order, build tool_result blocks.
    const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = [];
    let terminalFired = false;

    for (const toolUse of toolUses) {
      toolCallCount += 1;
      if (toolCallCount > maxToolCalls) {
        logStep?.({
          stage: 'agentic.tool_cap_hit',
          level: 'WARN',
          message: `Tool-call cap (${maxToolCalls}) reached; aborting agent run.`,
          data: { toolCallCount },
        });
        return {
          ok: false,
          reason: 'tool_cap',
          toolCallCount,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        };
      }

      const tool = toolSurface.byName.get(toolUse.name);
      if (!tool) {
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Unknown tool "${toolUse.name}". Use only tools listed in your tool surface.`,
          is_error: true,
        });
        continue;
      }

      const parsed = tool.inputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Invalid arguments for ${toolUse.name}: ${parsed.error.message}`,
          is_error: true,
        });
        continue;
      }

      let result: ToolResult;
      try {
        result = await tool.handler(parsed.data as z.output<typeof tool.inputSchema>, toolContext);
      } catch (err) {
        logStep?.({
          stage: 'agentic.tool_threw',
          level: 'ERROR',
          message: `Tool ${toolUse.name} threw: ${String(err)}`,
          data: { toolName: toolUse.name },
        });
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Tool ${toolUse.name} crashed: ${String(err)}`,
          is_error: true,
        });
        continue;
      }

      logStep?.({
        stage: 'agentic.tool_call',
        message: `Tool ${toolUse.name} ${result.isError ? 'returned error' : 'returned ok'}.`,
        data: { toolName: toolUse.name, isError: Boolean(result.isError), ...(result.data ?? {}) },
      });

      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.content,
        is_error: result.isError,
      });

      if (result.terminal) {
        terminalFired = true;
      }
    }

    messages.push({ role: 'user', content: toolResultBlocks });

    if (terminalFired) {
      return {
        ok: true,
        reason: 'terminal_tool',
        toolCallCount,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      };
    }
  }

  return {
    ok: false,
    reason: 'tool_cap',
    toolCallCount,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    error: 'iteration cap reached without terminal tool',
  };
}

/**
 * Helper that interpolates a list of available tools into the system prompt.
 * Useful when you want the agent to know what's available rather than
 * relying purely on tool definitions (which the model also sees, but a
 * short prose summary anchors planning).
 */
export function describeToolSurface(toolSurface: ToolSurface): string {
  if (toolSurface.tools.length === 0) return 'No tools available.';
  return toolSurface.tools.map(t => `- \`${t.name}\`: ${t.description.split('.')[0]}.`).join('\n');
}
