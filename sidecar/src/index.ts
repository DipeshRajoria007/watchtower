import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { WebClient } from '@slack/web-api';
import { loadConfigFromDb } from './config.js';
import { diagnoseFailure } from './learning/failureDoctor.js';
import { applyLearning } from './learning/selfLearning.js';
import { logger } from './logging/logger.js';
import { notifyDesktop } from './notify/desktopNotifier.js';
import { assertMacOS } from './platform.js';
import { normalizeTask } from './router/intentParser.js';
import { routeTask } from './router/taskRouter.js';
import { startMentionCatchup } from './slack/mentionCatchup.js';
import { SocketSlackClient } from './slack/socketClient.js';
import { fetchThreadContext } from './slack/threadContext.js';
import { JobStore } from './state/jobStore.js';
import type { SlackEventEnvelope, SlackReactionEvent, WorkflowStepLog } from './types/contracts.js';

assertMacOS();

const dbPath = process.env.WATCHTOWER_DB_PATH ?? path.resolve(process.cwd(), 'watchtower.db');
const config = loadConfigFromDb(dbPath);
const store = new JobStore(dbPath);

const queue: Array<{ event: SlackEventEnvelope; client: WebClient }> = [];
let running = 0;
const OPS_FEED_INTERVAL_MS = 30 * 60 * 1000;
const DAILY_DIGEST_TICK_MS = 60 * 1000;
const INCIDENT_TICK_MS = 5 * 60 * 1000;
const INCIDENT_CADENCE_MINUTES = 30;

const nonActionableSubtypes = new Set(['message_changed', 'message_deleted', 'bot_message']);

function dedupeKey(event: SlackEventEnvelope, intent: string): string {
  return `${event.channelId}:${event.threadTs}:${event.eventTs}:${intent}`;
}

function isTransientError(message: string): boolean {
  return /ETIMEDOUT|ECONNRESET|429|SlackApiError|timeout/i.test(message);
}

async function postFailureDoctorHint(params: {
  client: WebClient;
  event: SlackEventEnvelope;
  errorKind: string;
  summary: string;
  actions: string[];
  logStep: (step: WorkflowStepLog) => void;
}): Promise<void> {
  const { client, event, errorKind, summary, actions, logStep } = params;
  const actionLines = actions.slice(0, 3).map(action => `- ${action}`).join('\n');
  const text = [`Failure Doctor: ${summary}`, `Type: ${errorKind}`];
  if (actionLines) {
    text.push('Suggested fixes:', actionLines);
  }

  try {
    await client.chat.postMessage({
      channel: event.channelId,
      thread_ts: event.threadTs,
      text: text.join('\n'),
    });
    logStep({
      stage: 'failure_doctor.slack_posted',
      message: 'Posted Failure Doctor diagnosis to Slack thread.',
      level: 'WARN',
      data: {
        errorKind,
      },
    });
  } catch (error) {
    logStep({
      stage: 'failure_doctor.slack_failed',
      message: 'Failed to post Failure Doctor diagnosis to Slack thread.',
      level: 'WARN',
      data: {
        errorKind,
        error: String(error),
      },
    });
  }
}

function reactionToSentiment(reaction: string): -1 | 0 | 1 {
  const value = reaction.toLowerCase();
  if (value === 'thumbsup' || value === '+1') {
    return 1;
  }
  if (value === 'thumbsdown' || value === '-1') {
    return -1;
  }
  if (value === 'brain') {
    return 1;
  }
  return 0;
}

async function processReactionFeedback(event: SlackReactionEvent): Promise<void> {
  if (!event.channelId || !event.threadTs || !event.userId) {
    return;
  }
  if (store.hasEvent(event.eventId)) {
    return;
  }

  const sentiment = reactionToSentiment(event.reaction);
  store.recordEvent(event.eventId, event.channelId, event.threadTs);
  store.recordReactionFeedback({
    eventId: event.eventId,
    channelId: event.channelId,
    threadTs: event.threadTs,
    userId: event.userId,
    reaction: event.reaction,
    sentiment,
  });

  // Reactions on bot outputs become lightweight preference signals.
  if (event.itemUserId === config.botUserId) {
    if (sentiment < 0) {
      store.setPersonalityProfile({
        scope: 'channel',
        scopeId: event.channelId,
        mode: 'professional',
        source: `reaction:${event.reaction}`,
      });
    } else if (event.reaction.toLowerCase() === 'thumbsup' || event.reaction.toLowerCase() === '+1') {
      store.setPersonalityProfile({
        scope: 'channel',
        scopeId: event.channelId,
        mode: 'friendly',
        source: `reaction:${event.reaction}`,
      });
    }
  }

  logger.info(
    {
      eventId: event.eventId,
      channelId: event.channelId,
      threadTs: event.threadTs,
      reaction: event.reaction,
      sentiment,
      itemUserId: event.itemUserId ?? null,
    },
    'reaction feedback ingested'
  );
}

function buildOpsFeedAlert(): string | undefined {
  const snapshot = store.getDevStatusSnapshot();
  const failures = store.listDevRuns(5, 'FAILED');
  const recentRuns = store.listDevRuns(50);
  const staleReviews = recentRuns.filter(run => run.workflow === 'PR_REVIEW' && run.status === 'PAUSED').length;

  const alerts: string[] = [];
  if (snapshot.failures24h >= 3) {
    alerts.push(`repeat failures detected (${snapshot.failures24h} failed runs in 24h)`);
  }
  if (snapshot.successRate24h < 85) {
    alerts.push(`risky deploy window: success rate is ${snapshot.successRate24h}%`);
  }
  if (staleReviews >= 2) {
    alerts.push(`stale review backlog detected (${staleReviews} paused PR review jobs)`);
  }

  if (alerts.length === 0) {
    return undefined;
  }

  const topFailure = failures[0];
  const topFailureLine = topFailure
    ? `Latest failure: ${topFailure.workflow} (${topFailure.errorMessage ?? 'no error text'})`
    : undefined;

  return [
    'Proactive Ops Feed:',
    ...alerts.map(item => `- ${item}`),
    topFailureLine ? `- ${topFailureLine}` : '',
    '- Use `wt failures 10` and `wt diagnose <jobId>` for quick triage.',
  ]
    .filter(Boolean)
    .join('\n');
}

function startProactiveOpsFeed(client: WebClient): void {
  const tick = async (): Promise<void> => {
    try {
      const channels = store.listOpsFeedChannels();
      if (channels.length === 0) {
        return;
      }

      const alertText = buildOpsFeedAlert();
      if (!alertText) {
        return;
      }

      for (const channelId of channels) {
        await client.chat.postMessage({
          channel: channelId,
          text: alertText,
        });
      }
    } catch (error) {
      logger.warn({ error: String(error) }, 'proactive ops feed tick failed');
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, OPS_FEED_INTERVAL_MS);
}

function localHHMM(date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function localDateKey(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function buildDailyDigestMessage(): string {
  const snapshot = store.getDevStatusSnapshot();
  const failures = store.listDevRuns(3, 'FAILED');
  const failureLine = failures[0]
    ? `- Latest failure: ${failures[0].workflow} (${failures[0].errorMessage ?? 'no error text'})`
    : '- Latest failure: none';

  return [
    'Daily Autopilot Digest:',
    `- Active jobs: ${snapshot.activeJobs}/${config.maxConcurrentJobs}`,
    `- Runs (24h): ${snapshot.runs24h}`,
    `- Failures (24h): ${snapshot.failures24h}`,
    `- Success rate (24h): ${snapshot.successRate24h}%`,
    failureLine,
  ].join('\n');
}

function startDailyDigestTicker(client: WebClient): void {
  const tick = async (): Promise<void> => {
    try {
      const schedules = store.listDailyDigestSchedules();
      if (schedules.length === 0) {
        return;
      }

      const now = new Date();
      const hhmm = localHHMM(now);
      const dateKey = localDateKey(now);
      const digest = buildDailyDigestMessage();

      for (const schedule of schedules) {
        if (schedule.digestTime !== hhmm) {
          continue;
        }
        if (store.wasDigestSentToday(schedule.channelId, dateKey)) {
          continue;
        }

        await client.chat.postMessage({
          channel: schedule.channelId,
          text: digest,
        });
        store.markDigestSentToday(schedule.channelId, dateKey);
      }
    } catch (error) {
      logger.warn({ error: String(error) }, 'daily digest tick failed');
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, DAILY_DIGEST_TICK_MS);
}

function buildIncidentCadenceMessage(channelId: string): string | undefined {
  const snapshot = store.getIncidentSnapshot(channelId);
  if (snapshot.running === 0 && snapshot.failed60m === 0 && snapshot.paused60m === 0) {
    return undefined;
  }

  return [
    'Incident Commander Update:',
    `- Running jobs: ${snapshot.running}`,
    `- Failed jobs (last 60m): ${snapshot.failed60m}`,
    `- Paused jobs (last 60m): ${snapshot.paused60m}`,
    `- Dominant workflow impact: ${snapshot.topWorkflow}`,
    '- Use `wt failures 10` and `wt diagnose <jobId>` for next action.',
  ].join('\n');
}

function shouldPostIncidentCadence(channelId: string, nowMs: number): boolean {
  const key = `incident:last_post:${channelId}`;
  const previous = Number(store.getState(key) ?? '0');
  const minGapMs = INCIDENT_CADENCE_MINUTES * 60 * 1000;
  if (Number.isFinite(previous) && previous > 0 && nowMs - previous < minGapMs) {
    return false;
  }
  store.setState(key, String(nowMs));
  return true;
}

function startIncidentCommanderFeed(client: WebClient): void {
  const tick = async (): Promise<void> => {
    try {
      const channels = store.listIncidentChannels();
      if (channels.length === 0) {
        return;
      }

      const nowMs = Date.now();
      for (const channelId of channels) {
        if (!shouldPostIncidentCadence(channelId, nowMs)) {
          continue;
        }
        const text = buildIncidentCadenceMessage(channelId);
        if (!text) {
          continue;
        }
        await client.chat.postMessage({
          channel: channelId,
          text,
        });
      }
    } catch (error) {
      logger.warn({ error: String(error) }, 'incident commander tick failed');
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, INCIDENT_TICK_MS);
}

async function enqueueSlackEvent(event: SlackEventEnvelope, client: WebClient, source: 'socket' | 'catchup'): Promise<void> {
  queue.push({ event, client });
  logger.info({ queueDepth: queue.length, eventId: event.eventId, source }, 'event queued for processing');
  await processNext();
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

  if (store.hasJobForEventTs(event.channelId, event.eventTs)) {
    store.recordEvent(event.eventId, event.channelId, event.threadTs);
    logger.info({ eventId: event.eventId, channelId: event.channelId, eventTs: event.eventTs }, 'duplicate channel/eventTs ignored');
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

  const learning = applyLearning({ task, config, store });
  const routedTask = learning.intent === task.intent ? task : { ...task, intent: learning.intent };

  logger.info(
    {
      eventId: event.eventId,
      originalIntent: task.intent,
      routedIntent: routedTask.intent,
      correctionApplied: learning.correctionApplied,
      personalityMode: learning.personalityMode,
      learningNotes: learning.notes,
    },
    'learning engine evaluated task'
  );

  const key = dedupeKey(event, routedTask.intent);
  store.recordEvent(event.eventId, event.channelId, event.threadTs);

  const jobId = uuidv4();
  store.createJob({
    id: jobId,
    eventId: event.eventId,
    dedupeKey: key,
    workflow: routedTask.intent,
    channelId: event.channelId,
    threadTs: event.threadTs,
    payload: {
      text: event.text,
      requestUserId: event.userId,
      mentionType: task.mentionType,
      intent: routedTask.intent,
      originalIntent: task.intent,
      correctionApplied: learning.correctionApplied,
      personalityMode: learning.personalityMode,
      learningNotes: learning.notes,
      eventTs: event.eventTs,
    },
  });

  const stepLogs: WorkflowStepLog[] = [];

  const logStep = (step: WorkflowStepLog): void => {
    stepLogs.push({
      level: step.level ?? 'INFO',
      stage: step.stage,
      message: step.message,
      data: step.data,
    });

    const level = step.level ?? 'INFO';
    const payload = {
      jobId,
      eventId: event.eventId,
      workflow: routedTask.intent,
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
      intent: routedTask.intent,
      originalIntent: task.intent,
      correctionApplied: learning.correctionApplied,
      personalityMode: learning.personalityMode,
      learningNotes: learning.notes,
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
        const result = await routeTask({
          task: routedTask,
          config,
          slack: client,
          store,
          personalityMode: learning.personalityMode,
          logStep,
        });
        const diagnosis =
          result.status === 'FAILED'
            ? diagnoseFailure({
                workflow: routedTask.intent,
                message: result.message,
                logs: stepLogs,
              })
            : undefined;

        if (diagnosis) {
          logStep({
            stage: 'failure_doctor.diagnosed',
            message: 'Failure Doctor produced a diagnosis for workflow failure.',
            level: 'WARN',
            data: diagnosis,
          });

          await postFailureDoctorHint({
            client,
            event,
            errorKind: diagnosis.errorKind,
            summary: diagnosis.summary,
            actions: diagnosis.actions,
            logStep,
          });
        }

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

        try {
          store.recordLearningSignal({
            jobId,
            eventId: event.eventId,
            channelId: event.channelId,
            userId: event.userId,
            workflow: routedTask.intent,
            intent: task.intent,
            status: result.status,
            correctionApplied: learning.correctionApplied,
            personalityMode: learning.personalityMode,
            errorKind: diagnosis?.errorKind,
          });
        } catch (error) {
          logStep({
            stage: 'learning.signal.persist_failed',
            message: 'Failed to persist learning signal.',
            level: 'WARN',
            data: {
              error: String(error),
            },
          });
        }

        return;
      } catch (error) {
        lastError = error;
        const msg = String(error);
        const transient = isTransientError(msg);
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
    const diagnosis = diagnoseFailure({
      workflow: routedTask.intent,
      message: errorMessage,
      logs: stepLogs,
    });

    if (diagnosis) {
      logStep({
        stage: 'failure_doctor.diagnosed',
        message: 'Failure Doctor produced a diagnosis after retries were exhausted.',
        level: 'WARN',
        data: diagnosis,
      });
    }

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

    if (diagnosis) {
      await postFailureDoctorHint({
        client,
        event,
        errorKind: diagnosis.errorKind,
        summary: diagnosis.summary,
        actions: diagnosis.actions,
        logStep,
      });
    }

    logStep({
      stage: 'job.failed.slack_posted',
      message: 'Posted hard-failure message to Slack thread.',
      level: 'ERROR',
    });

    notifyDesktop('Watchtower workflow failed', errorMessage);
    store.markJob(jobId, 'FAILED', { errorMessage });
    try {
      store.recordLearningSignal({
        jobId,
        eventId: event.eventId,
        channelId: event.channelId,
        userId: event.userId,
        workflow: routedTask.intent,
        intent: task.intent,
        status: 'FAILED',
        correctionApplied: learning.correctionApplied,
        personalityMode: learning.personalityMode,
        errorKind: diagnosis?.errorKind,
      });
    } catch (error) {
      logStep({
        stage: 'learning.signal.persist_failed',
        message: 'Failed to persist learning signal after retries.',
        level: 'WARN',
        data: {
          error: String(error),
        },
      });
    }
  } catch (error) {
    const errorMessage = String(error);
    const diagnosis = diagnoseFailure({
      workflow: routedTask.intent,
      message: errorMessage,
      logs: stepLogs,
    });

    if (diagnosis) {
      logStep({
        stage: 'failure_doctor.diagnosed',
        message: 'Failure Doctor produced a diagnosis for unexpected process failure.',
        level: 'WARN',
        data: diagnosis,
      });
    }

    logger.error({ jobId, eventId: event.eventId, error: errorMessage }, 'unexpected processEvent failure');
    notifyDesktop('Watchtower job failure', errorMessage);
    store.markJob(jobId, 'FAILED', { errorMessage });
    try {
      store.recordLearningSignal({
        jobId,
        eventId: event.eventId,
        channelId: event.channelId,
        userId: event.userId,
        workflow: routedTask.intent,
        intent: task.intent,
        status: 'FAILED',
        correctionApplied: learning.correctionApplied,
        personalityMode: learning.personalityMode,
        errorKind: diagnosis?.errorKind,
      });
    } catch {
      // ignore persistence failures in terminal error path
    }
  }
}

async function main(): Promise<void> {
  logger.info({ dbPath, maxConcurrentJobs: config.maxConcurrentJobs }, 'watchtower sidecar starting');

  const client = new SocketSlackClient(
    config,
    async (event, webClient) => {
      await enqueueSlackEvent(event, webClient as WebClient, 'socket');
    },
    async event => {
      await processReactionFeedback(event);
    }
  );

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

  startProactiveOpsFeed(client.webClient as WebClient);
  startDailyDigestTicker(client.webClient as WebClient);
  startIncidentCommanderFeed(client.webClient as WebClient);

  startMentionCatchup({
    webClient: client.webClient,
    config,
    store,
    enqueue: enqueueSlackEvent,
  });
}

main().catch(error => {
  logger.error({ error: String(error) }, 'watchtower sidecar crashed');
  notifyDesktop('Watchtower sidecar crash', String(error));
  process.exit(1);
});
