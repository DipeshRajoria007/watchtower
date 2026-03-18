import os from 'node:os';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { lightweightProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { fetchThreadContext } from '../slack/threadContext.js';
import {
  formatThreadContext,
  stripMentions,
  isPresencePing,
  buildPresenceReply,
  extractReplyFromCodexResult,
} from './shared/workflowUtils.js';

export async function runConversationalWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, config: _config, slack, logStep } = params;
  const userInput = stripMentions(task.event.text);

  // Fast path: presence pings don't need an AI call
  if (isPresencePing(userInput)) {
    const presenceReply = buildPresenceReply(task.event.eventTs);
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: presenceReply,
    });

    logStep?.({
      stage: 'conversational.presence.reply_posted',
      message: 'Posted direct presence acknowledgement.',
      data: { userInput },
    });

    return {
      workflow: 'CONVERSATIONAL',
      status: 'SUCCESS',
      message: presenceReply,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  logStep?.({
    stage: 'conversational.start',
    message: 'Running conversational workflow.',
  });

  // Fetch thread context for conversation flow
  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs).catch(() => []);
  const threadContext = formatThreadContext(task, threadMessages);

  const prompt = `
${buildMentionSystemPrompt({ task, workflow: 'CONVERSATIONAL' })}

Context:
- You are miniOG, a developer assistant bot in a Slack workspace.
- The user @mentioned you in a Slack thread with a casual/conversational message.
- Your response will be posted DIRECTLY into that Slack thread as-is. No transformation, no wrapping — what you write is exactly what the user sees.

Instructions:
- Reply naturally, briefly, and in a friendly tone. Be human.
- Write your response as a ready-to-post Slack message.
- Use Slack markdown if needed (*bold*, _italic_, \`code\`).
- No code changes, no file operations, no actions needed.

Slack thread context:
${threadContext}
`.trim();

  const profile = lightweightProfile(getActiveBackendId());
  const result = await runCodex({
    cwd: os.tmpdir(),
    prompt,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    timeoutMs: 30_000,
    onLog: logStep,
  });

  const reply = extractReplyFromCodexResult(result) || "I'm here. What do you need?";

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: reply,
  });

  logStep?.({
    stage: 'conversational.done',
    message: 'Posted conversational reply.',
  });

  return {
    workflow: 'CONVERSATIONAL',
    status: 'SUCCESS',
    message: reply,
    notifyDesktop: false,
    slackPosted: true,
  };
}
