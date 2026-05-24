import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';
import { buildToolSurface, type AgenticMode } from './tools/index.js';
import { describeToolSurface, runClaudeAgentic } from './runClaude.js';

export interface RunAgenticEntryParams {
  mode: AgenticMode;
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store: JobStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}

const INFORMATIONAL_SYSTEM_PROMPT = `You are miniOG, a Slack assistant. The user has asked an informational question — code lookup, "where is X", "how does Y work", documentation. Your job:

1. Read the user's message (which appears as the first user turn).
2. Use \`search_codebase\` / \`read_file\` / \`list_files\` to find the answer in newton-web, newton-api, or watchtower. Be efficient — don't grep for tangential things.
3. If you need conversation context, call \`get_thread_context\` once.
4. Compose a concise Slack reply citing file:line refs. Use Slack markdown (\`code\`, *bold*, _italic_, bullets).
5. Call \`post_slack_reply(text)\` exactly once with your final answer. This ends the conversation.

Constraints:
- No JSON, no code fences around the reply, no preamble like "Here's what I found:".
- If you can't find what they asked about, say so directly — don't speculate.
- Stay terse. The user reads on Slack; long answers get skipped.`;

const CONVERSATIONAL_SYSTEM_PROMPT = `You are miniOG, a Slack assistant. The user is making a conversational request — greeting, status check, casual chat, or a question about miniOG itself. Your job:

1. Read the user's message and produce a short, human reply.
2. If the user references prior thread context, call \`get_thread_context\` once.
3. Call \`post_slack_reply(text)\` exactly once with your reply.

FORBIDDEN: You are NOT permitted to claim that code work was performed, that a PR was opened, that a deploy ran, or that a fix shipped. If the user is asking about an in-flight task, your only allowed response is to acknowledge (e.g. "on it", "checking", "will share when ready") or to defer. NEVER assert completion of work you did not do.

Keep replies short — one or two sentences usually. Slack markdown is fine but optional.`;

/**
 * Unified entry point that replaces informationalWorkflow + conversationalWorkflow.
 * Builds a tool surface filtered by the caller's capabilities, then runs a
 * multi-turn agentic loop with Claude until either a terminal tool fires
 * (post_slack_reply) or the model stops.
 *
 * Returns a WorkflowResult compatible with the legacy taskRouter dispatch.
 */
export async function runAgenticEntry(params: RunAgenticEntryParams): Promise<WorkflowResult> {
  const { mode, task, config, slack, store, jobId, logStep, signal } = params;

  const toolSurface = buildToolSurface({ mode, task, config });
  logStep?.({
    stage: 'agentic.start',
    message: `Agentic entry starting in ${mode} mode with ${toolSurface.tools.length} tools.`,
    data: {
      mode,
      toolNames: toolSurface.tools.map(t => t.name),
      userId: task.event.userId,
    },
  });

  const systemPromptBase = mode === 'informational' ? INFORMATIONAL_SYSTEM_PROMPT : CONVERSATIONAL_SYSTEM_PROMPT;

  // Conversational guardrail: when investigation findings are pending for
  // this thread, prepend a steer so the agent does NOT claim work is done.
  let systemPrompt = systemPromptBase;
  if (mode === 'conversational') {
    try {
      const pending = store.investigationStore().getForThread(task.event.threadTs);
      if (pending) {
        systemPrompt = `${systemPromptBase}\n\nIMPORTANT: This thread has pending investigation findings from a prior turn. The user may be following up on a fix. Do NOT claim the fix is done. Instead, steer ("on it", "starting now", "will share the PR shortly") and defer to the implementation pipeline.`;
        logStep?.({
          stage: 'agentic.conversational_steer',
          message: 'Pending investigation findings detected; injected fake-completion guardrail.',
        });
      }
    } catch {
      // investigationStore may not be available in all builds; non-fatal.
    }
  }

  const toolListing = describeToolSurface(toolSurface);
  systemPrompt = `${systemPrompt}\n\nAvailable tools:\n${toolListing}`;

  const result = await runClaudeAgentic({
    systemPrompt,
    userMessage: task.event.text || '(empty message)',
    toolSurface,
    toolContext: { task, config, slack, store, jobId, logStep, signal },
    logStep,
    signal,
    store,
    jobId,
    role: mode === 'informational' ? 'agentic_informational' : 'agentic_conversational',
  });

  logStep?.({
    stage: 'agentic.done',
    message: `Agentic run finished: ${result.reason} (${result.toolCallCount} tool calls).`,
    level: result.ok ? 'INFO' : 'WARN',
    data: {
      reason: result.reason,
      toolCallCount: result.toolCallCount,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheCreationTokens: result.cacheCreationTokens,
      error: result.error,
    },
  });

  // If the agent finished without posting to Slack (natural_end or tool_cap),
  // post a fallback reply so the user isn't left hanging.
  let slackPosted = result.reason === 'terminal_tool';
  if (!slackPosted) {
    const fallbackText =
      result.reason === 'natural_end' && result.finalText
        ? result.finalText
        : result.reason === 'tool_cap'
          ? 'I lost the plot here — too many tool calls without landing on an answer. Try rephrasing or splitting the question.'
          : result.reason === 'aborted'
            ? 'Request was cancelled.'
            : `Something went wrong: ${result.error ?? 'unknown error'}`;
    try {
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: fallbackText,
      });
      slackPosted = true;
    } catch (err) {
      logStep?.({
        stage: 'agentic.slack_fallback_failed',
        level: 'ERROR',
        message: `Could not post fallback reply: ${String(err)}`,
      });
    }
  }

  return {
    workflow: mode === 'informational' ? 'INFORMATIONAL' : 'CONVERSATIONAL',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    message: result.error ?? `Agentic ${mode} run completed (${result.reason}).`,
    notifyDesktop: !result.ok,
    slackPosted,
  };
}
