import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import type { WebClient } from '@slack/web-api';
import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { logger } from './logging/logger.js';
import { notifyDesktop } from './notify/desktopNotifier.js';
import { assertMacOS } from './platform.js';
import { normalizeTask } from './router/intentParser.js';
import { routeTask } from './router/taskRouter.js';
import { SocketSlackClient } from './slack/socketClient.js';
import { fetchThreadContext } from './slack/threadContext.js';
import { JobStore } from './state/jobStore.js';
import type { SlackEventEnvelope } from './types/contracts.js';

const envPathCandidates = [
  process.env.WATCHTOWER_ENV_PATH,
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../.env'),
].filter(Boolean) as string[];

for (const candidate of envPathCandidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false });
    break;
  }
}

assertMacOS();

const config = loadConfig();
const dbPath = process.env.WATCHTOWER_DB_PATH ?? path.resolve(process.cwd(), 'watchtower.db');
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

  const threadMessages = await fetchThreadContext(client, event.channelId, event.threadTs).catch(() => []);
  const threadTexts = threadMessages.map(message => message.text);
  const task = normalizeTask(event, config, threadTexts);

  if (!task.mentionDetected) {
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

  try {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < 3) {
      attempt += 1;
      store.bumpAttempt(jobId);
      try {
        const result = await routeTask({ task, config, slack: client });
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
        if (!transient || attempt >= 3) {
          break;
        }
      }
    }

    const errorMessage = `Workflow failed after retries: ${String(lastError)}`;
    await client.chat.postMessage({
      channel: event.channelId,
      thread_ts: event.threadTs,
      text: `${errorMessage}`,
    }).catch(() => {});
    notifyDesktop('Watchtower workflow failed', errorMessage);
    store.markJob(jobId, 'FAILED', { errorMessage });
  } catch (error) {
    const errorMessage = String(error);
    notifyDesktop('Watchtower job failure', errorMessage);
    store.markJob(jobId, 'FAILED', { errorMessage });
  }
}

async function main(): Promise<void> {
  logger.info({ dbPath, maxConcurrentJobs: config.maxConcurrentJobs }, 'watchtower sidecar starting');

  const client = new SocketSlackClient(config, async (event, webClient) => {
    queue.push({ event, client: webClient as WebClient });
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
