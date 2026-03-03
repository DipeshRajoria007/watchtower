import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { WebClient } from '@slack/web-api';
import { loadConfigFromDb } from './config.js';
import { logger } from './logging/logger.js';
import { notifyDesktop } from './notify/desktopNotifier.js';
import { assertMacOS } from './platform.js';
import { normalizeTask } from './router/intentParser.js';
import { routeTask } from './router/taskRouter.js';
import { SocketSlackClient } from './slack/socketClient.js';
import { fetchThreadContext } from './slack/threadContext.js';
import { JobStore } from './state/jobStore.js';
import type { SlackEventEnvelope, WorkflowStepLog } from './types/contracts.js';

assertMacOS();

const dbPath = process.env.WATCHTOWER_DB_PATH ?? path.resolve(process.cwd(), 'watchtower.db');
const config = loadConfigFromDb(dbPath);
const store = new JobStore(dbPath);

const queue: Array<{ event: SlackEventEnvelope; client: WebClient }> = [];
let running = 0;

const nonActionableSubtypes = new Set(['message_changed', 'message_deleted', 'bot_message']);

function dedupeKey(event: SlackEventEnvelope, intent: string): string {
  return `${event.channelId}:${event.threadTs}:${intent}`;
}

async function processNext(): Promise<void> {
  if (running >= config.maxConcurrentJobs) {
    return;
  }
  const item = queue.shift();
  if (!item) {
    return;
  }

  running += 1;
  try {
    await processEvent(item.event, item.client);
  } finally {
    running -= 1;
    await processNext();
  }
}

async function processEvent(event: SlackEventEnvelope, client: WebClient): Promise<void> {
  logger.info(
    {
      eventId: event.eventId,
      channelId: event.channelId,
      threadTs: event.threadTs,
      subtype: event.messageSubtype ?? null,
    },
    'slack event received'
  );

  if (event.messageSubtype && nonActionableSubtypes.has(event.messageSubtype)) {
    logger.info({ eventId: event.eventId, subtype: event.messageSubtype }, 'skip message subtype');
    return;
  }

  if (!event.userId || event.userId === config.botUserId) {
    logger.info({ eventId: event.eventId }, 'skip empty or bot-originated event');
    return;
  }

  if (store.hasEvent(event.eventId)) {
    logger.info({ eventId: event.eventId }, 'duplicate event ignored');
    return;
  }

  logger.info({ eventId: event.eventId }, 'fetching thread context for intake');
  const threadMessages = await fetchThreadContext(client, event.channelId, event.threadTs).catch(() => []);
  const threadTexts = threadMessages.map(message => message.text);
  logger.info({ eventId: event.eventId, messages: threadMessages.length }, 'thread context fetched for intake');
  const task = normalizeTask(event, config, threadTexts);

  logger.info(
    {
      eventId: event.eventId,
      mentionDetected: task.mentionDetected,
      mentionType: task.mentionType,
      intent: task.intent,
    },
    'task normalized from slack event'
  );

  if (!task.mentionDetected) {
    logger.info({ eventId: event.eventId }, 'skip non-mention message');
    return;
  }

  const key = dedupeKey(event, task.intent);
  if (store.hasDedupeKey(key)) {
    logger.info({ dedupeKey: key }, 'duplicate dedupe key ignored');
    store.recordEvent(event.eventId, event.channelId, event.threadTs);
    return;
  }

  store.recordEvent(event.eventId, event.channelId, event.threadTs);

  const jobId = uuidv4();
  store.createJob({
    id: jobId,
    eventId: event.eventId,
    dedupeKey: key,
    workflow: task.intent,
    channelId: event.channelId,
    threadTs: event.threadTs,
    payload: {
      text: event.text,
      mentionType: task.mentionType,
      intent: task.intent,
    },
  });

  const logStep = (step: WorkflowStepLog): void => {
    const level = step.level ?? 'INFO';
    const payload = {
      jobId,
      eventId: event.eventId,
      workflow: task.intent,
      stage: step.stage,
      ...(step.data ? { data: step.data } : {}),
    };

    if (level === 'ERROR') {
      logger.error(payload, step.message);
    } else if (level === 'WARN') {
      logger.warn(payload, step.message);
    } else {
      logger.info(payload, step.message);
    }

    try {
      store.appendJobLog({
        jobId,
        stage: step.stage,
        message: step.message,
        level,
        data: step.data,
      });
    } catch (error) {
      logger.error(
        {
          jobId,
          eventId: event.eventId,
          stage: step.stage,
          error: String(error),
        },
        'failed to persist workflow step log'
      );
    }
  };

  logStep({
    stage: 'job.created',
    message: 'Created job record for tagged message.',
    data: {
      dedupeKey: key,
      mentionType: task.mentionType,
      intent: task.intent,
      threadMessages: threadMessages.length,
    },
  });

  try {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < 3) {
      attempt += 1;
      store.bumpAttempt(jobId);
      logStep({
        stage: 'job.attempt.start',
        message: 'Starting workflow attempt.',
        data: {
          attempt,
          maxAttempts: 3,
        },
      });
      try {
        const result = await routeTask({ task, config, slack: client, logStep });
        logStep({
          stage: 'job.attempt.result',
          message: 'Workflow attempt returned a result.',
          level: result.status === 'FAILED' ? 'ERROR' : 'INFO',
          data: {
            status: result.status,
            message: result.message,
            slackPosted: result.slackPosted,
            notifyDesktop: result.notifyDesktop,
          },
        });
        if (result.status === 'SUCCESS') {
          store.markJob(jobId, 'SUCCESS', { result: result.result });
        } else if (result.status === 'PAUSED') {
          store.markJob(jobId, 'PAUSED', { result: result.result });
        } else if (result.status === 'SKIPPED') {
          store.markJob(jobId, 'SKIPPED', { result: result.result });
        } else {
          store.markJob(jobId, 'FAILED', { errorMessage: result.message, result: result.result });
        }
        return;
      } catch (error) {
        lastError = error;
        const msg = String(error);
        const transient = /ETIMEDOUT|ECONNRESET|429|SlackApiError|timeout/i.test(msg);
        logger.error({ error: msg, attempt, jobId }, 'job attempt failed');
        logStep({
          stage: 'job.attempt.exception',
          message: 'Workflow attempt threw an exception.',
          level: 'ERROR',
          data: {
            attempt,
            transient,
            error: msg,
          },
        });
        if (!transient || attempt >= 3) {
          break;
        }
        logStep({
          stage: 'job.attempt.retry_scheduled',
          message: 'Transient failure detected; retrying workflow.',
          level: 'WARN',
          data: {
            attempt,
            nextAttempt: attempt + 1,
          },
        });
      }
    }

    const errorMessage = `Workflow failed after retries: ${String(lastError)}`;
    logStep({
      stage: 'job.failed.after_retries',
      message: 'Workflow exhausted retry budget and will be marked failed.',
      level: 'ERROR',
      data: {
        errorMessage,
      },
    });

    await client.chat.postMessage({
      channel: event.channelId,
      thread_ts: event.threadTs,
      text: `${errorMessage}`,
    }).catch(() => {});

    logStep({
      stage: 'job.failed.slack_posted',
      message: 'Posted hard-failure message to Slack thread.',
      level: 'ERROR',
    });

    notifyDesktop('Watchtower workflow failed', errorMessage);
    store.markJob(jobId, 'FAILED', { errorMessage });
  } catch (error) {
    const errorMessage = String(error);
    logger.error({ jobId, eventId: event.eventId, error: errorMessage }, 'unexpected processEvent failure');
    notifyDesktop('Watchtower job failure', errorMessage);
    store.markJob(jobId, 'FAILED', { errorMessage });
  }
}

async function main(): Promise<void> {
  logger.info({ dbPath, maxConcurrentJobs: config.maxConcurrentJobs }, 'watchtower sidecar starting');

  const client = new SocketSlackClient(config, async (event, webClient) => {
    queue.push({ event, client: webClient as WebClient });
    logger.info({ queueDepth: queue.length, eventId: event.eventId }, 'event queued for processing');
    await processNext();
  });

  process.on('SIGINT', () => {
    logger.info('received SIGINT');
    store.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('received SIGTERM');
    store.close();
    process.exit(0);
  });

  await client.start();
}

main().catch(error => {
  logger.error({ error: String(error) }, 'watchtower sidecar crashed');
  notifyDesktop('Watchtower sidecar crash', String(error));
  process.exit(1);
});
