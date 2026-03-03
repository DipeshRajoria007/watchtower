import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, CodexRunRequest, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex } from '../codex/runCodex.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { fetchThreadContext } from '../slack/threadContext.js';

type UnknownReply = {
  reply: string;
  reaction: string;
};

function sanitizeReaction(reaction: string | undefined): string {
  if (!reaction) {
    return 'skull';
  }
  const value = reaction.trim().toLowerCase();
  if (/^[a-z0-9_+-]+$/.test(value)) {
    return value;
  }
  return 'skull';
}

function sanitizeReply(reply: string | undefined, userId: string): string {
  const trimmed = (reply ?? '').trim();
  if (trimmed.length > 0) {
    return `<@${userId}> ${trimmed}`;
  }
  return `<@${userId}> your request is random enough to trigger chaos mode, but I need a concrete task to proceed.`;
}

async function generateUnknownReplyWithCodex(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
}): Promise<UnknownReply> {
  const { task, config, slack, logStep } = params;

  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs).catch(() => []);
  const threadContext = [task.event.text, ...threadMessages.map(message => message.text)]
    .filter(Boolean)
    .join('\n---\n');

  const prompt = `
Generate a Slack reply for an unknown/random bot mention.

Rules:
1. Tone: dark/suspicious humor, witty, short.
2. Safe: no hate, no abuse, no threats.
3. Keep reply to max 24 words.
4. Reply text must NOT include user mention. Mention is added externally.
5. Pick one fitting Slack emoji reaction name (without colons), e.g. skull, eyes, ghost, melting_face.

Context:
- Mention text: ${task.event.text}
- Thread context:
${threadContext || '(empty)'}

Return strict JSON with keys:
- reply (string)
- reaction (string)
`.trim();

  const request: CodexRunRequest = {
    cwd: process.cwd(),
    prompt,
    timeoutMs: Math.min(config.workflowTimeouts.prReviewMs, 120_000),
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/unknown-task-result.schema.json'),
    reasoningEffort: 'low',
    onLog: logStep,
  };

  logStep?.({
    stage: 'unknown.codex.start',
    message: 'Generating unknown-task reply with Codex (low reasoning effort).',
    data: {
      timeoutMs: request.timeoutMs,
      threadMessages: threadMessages.length,
    },
  });

  const result = await runCodex(request);

  logStep?.({
    stage: 'unknown.codex.finish',
    message: 'Unknown-task Codex generation finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: {
      ok: result.ok,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      parsedJson: Boolean(result.parsedJson),
    },
  });

  if (!result.ok || !result.parsedJson) {
    return {
      reply: '',
      reaction: 'skull',
    };
  }

  return {
    reply: String(result.parsedJson.reply ?? ''),
    reaction: sanitizeReaction(String(result.parsedJson.reaction ?? '')),
  };
}

export async function runUnknownTaskWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  generateUnknownReply?: (input: {
    task: NormalizedTask;
    config: AppConfig;
    slack: WebClient;
    logStep?: WorkflowStepLogger;
  }) => Promise<UnknownReply>;
}): Promise<WorkflowResult> {
  const { task, config, slack, logStep, generateUnknownReply } = params;

  logStep?.({
    stage: 'unknown.notify.desktop',
    message: 'No configured workflow matched; generating dark-humor reply with Codex and notifying desktop.',
    level: 'WARN',
    data: {
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
    },
  });

  const generator = generateUnknownReply ?? generateUnknownReplyWithCodex;
  const generated = await generator({ task, config, slack, logStep });
  const replyText = sanitizeReply(generated.reply, task.event.userId);
  const reaction = sanitizeReaction(generated.reaction);

  let postedTs: string | undefined;
  try {
    const response = await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: replyText,
    });
    postedTs = response.ts;

    logStep?.({
      stage: 'unknown.slack.reply_posted',
      message: 'Posted unknown-task reply in Slack thread.',
      data: {
        userId: task.event.userId,
      },
    });
  } catch (error) {
    logStep?.({
      stage: 'unknown.slack.reply_failed',
      message: 'Failed to post unknown-task reply in Slack thread.',
      level: 'ERROR',
      data: {
        error: String(error),
      },
    });
  }

  if (postedTs) {
    try {
      await slack.reactions.add({
        channel: task.event.channelId,
        timestamp: postedTs,
        name: reaction,
      });

      logStep?.({
        stage: 'unknown.slack.reaction_added',
        message: 'Added reaction to unknown-task reply.',
        data: {
          reaction,
        },
      });
    } catch (error) {
      logStep?.({
        stage: 'unknown.slack.reaction_failed',
        message: 'Failed to add reaction to unknown-task reply.',
        level: 'WARN',
        data: {
          error: String(error),
        },
      });
    }
  }

  notifyDesktop(
    'Watchtower unknown task',
    `No configured workflow matched channel=${task.event.channelId} thread=${task.event.threadTs}`
  );

  return {
    workflow: 'UNKNOWN',
    status: 'SKIPPED',
    message: 'Unknown task; Codex-generated dark-humor Slack reply sent.',
    notifyDesktop: true,
    slackPosted: Boolean(postedTs),
  };
}
