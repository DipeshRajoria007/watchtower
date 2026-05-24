import type { z } from 'zod';
import { evaluateCapability } from '../../access/control.js';
import type { AppConfig, NormalizedTask } from '../../types/contracts.js';
import { searchCodebaseTool, readFileTool, listFilesTool } from './codebase.js';
import { getThreadContextTool, postSlackReplyTool } from './slack.js';
import { getUserDossierSelfTool, recallUserSignalsTool } from './dossier.js';
import type { ToolDefinition, ToolSurface } from './types.js';

export type AgenticMode = 'informational' | 'conversational';

// Use ZodType as the existential here so the array can hold tools with
// different input schemas — the surface treats them as opaque to the caller.
type AnyTool = ToolDefinition<z.ZodType>;

/**
 * Build the tool surface for an agent run. Filters by:
 *   1. Mode — conversational gets a smaller subset (no codebase tools).
 *   2. Per-tool capability check via `evaluateCapability` — tools the caller
 *      lacks capabilities for are NOT registered, so the agent never sees
 *      them.
 *
 * `post_slack_reply` and `get_thread_context` are always included because
 * they gate on `chat` (lowest tier) and the agent needs at least one way
 * to terminate.
 */
export function buildToolSurface(params: { mode: AgenticMode; task: NormalizedTask; config: AppConfig }): ToolSurface {
  const { mode, task, config } = params;
  const allByMode: AnyTool[] =
    mode === 'informational'
      ? [
          searchCodebaseTool as unknown as AnyTool,
          readFileTool as unknown as AnyTool,
          listFilesTool as unknown as AnyTool,
          getThreadContextTool as unknown as AnyTool,
          getUserDossierSelfTool as unknown as AnyTool,
          recallUserSignalsTool as unknown as AnyTool,
          postSlackReplyTool as unknown as AnyTool,
        ]
      : [
          getThreadContextTool as unknown as AnyTool,
          getUserDossierSelfTool as unknown as AnyTool,
          recallUserSignalsTool as unknown as AnyTool,
          postSlackReplyTool as unknown as AnyTool,
        ];

  const allowed: AnyTool[] = [];
  for (const tool of allByMode) {
    const decision = evaluateCapability({
      config,
      userId: task.event.userId,
      channelId: task.event.channelId,
      channelType: task.event.channelType,
      capability: tool.capability,
    });
    if (decision.allowed) {
      allowed.push(tool);
    }
  }

  return {
    tools: allowed,
    byName: new Map(allowed.map(t => [t.name, t])),
  };
}
