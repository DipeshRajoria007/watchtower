import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { WebClient } from '@slack/web-api';
import { getAdminUserIds, getConfiguredAccessControl, setResolvedGroupMembers } from './access/control.js';
import { loadConfigFromDb, readAgentBackend, readSettingsForAlert, MiniOgRepoRootViolationError } from './config.js';
import { setActiveBackend } from './codex/runCodex.js';
import { diagnoseFailure } from './learning/failureDoctor.js';
import { applyLearning } from './learning/selfLearning.js';
import {
  failLaunchpadWorkflow,
  finalizeLaunchpadWorkflowResult,
  markLaunchpadJobCreated,
} from './launchpad/launchpadLifecycle.js';
import { startLaunchpadRequestPoller } from './launchpad/launchpadIntake.js';
import { logger } from './logging/logger.js';
import { notifyDesktop } from './notify/desktopNotifier.js';
import { assertMacOS } from './platform.js';
import { evaluatePolicy, loadPolicies } from './policies/evaluator.js';
import { agentCallContext } from './state/runContext.js';
import { normalizeTask } from './router/intentParser.js';
import { decidePausedResume } from './router/pausedResume.js';
import { classifyProduct } from './router/productClassifier.js';
import { routeTask } from './router/taskRouter.js';
import { startMentionCatchup } from './slack/mentionCatchup.js';
import { SocketSlackClient } from './slack/socketClient.js';
import { cleanupStaleWorkspaces } from './workspaces/workspaceManager.js';
import { configureVaultWriter, shutdownVaultWriter } from './vault/vaultWriter.js';
import { configureVaultWatcher, shutdownVaultWatcher } from './vault/vaultWatcher.js';
import { startProfileSynthesizerScheduler, stopProfileSynthesizerScheduler } from './learning/profileSynthesizer.js';
import { loadWorkflowTemplates } from './workflows/registry.js';
import { fetchThreadContext } from './slack/threadContext.js';
import { resolveUserGroupMembers } from './slack/userGroupResolver.js';
import { registerActiveJob, unregisterActiveJob, cancelJob } from './state/activeJobs.js';
import { JobStore } from './state/jobStore.js';
import type { AccessGroupKey, SlackEventEnvelope, SlackReactionEvent, WorkflowStepLog } from './types/contracts.js';

assertMacOS();
loadPolicies();
loadWorkflowTemplates();

const dbPath = process.env.WATCHTOWER_DB_PATH ?? path.resolve(process.cwd(), 'watchtower.db');

let config: ReturnType<typeof loadConfigFromDb>;
try {
  config = loadConfigFromDb(dbPath);
} catch (error) {
  if (error instanceof MiniOgRepoRootViolationError) {
    const alertSettings = readSettingsForAlert(dbPath);
    if (alertSettings) {
      const mentions = alertSettings.adminUserIds.map(id => `<@${id}>`).join(' ');
      const header = `${mentions ? mentions + ' ' : ''}miniOG refuses to start — repo paths must live under \`${error.miniOgRepoRoot}\`.`;
      const detail = error.offending.map(o => `• \`${o.label}\`: \`${o.path}\``).join('\n');
      const text = `${header}\n${detail}\n\nMove the clones (or update settings) so every repo path is a subdirectory of the mini-og root, then restart miniOG.`;
      const alertClient = new WebClient(alertSettings.slackBotToken);
      alertClient.chat
        .postMessage({ channel: alertSettings.channelId, text })
        .catch(postError =>
          logger.warn({ error: String(postError) }, 'failed to post mini-og-root violation alert to Slack'),
        );
    }
    logger.error({ err: String(error) }, 'mini-og repo-root validation failed — refusing to start');
  }
  throw error;
}
setActiveBackend(config.agentBackend);
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

/**
 * Returns true when the workflow produces output worth saving as a per-user
 * memory entry. Chat / silent / unrouted / dossier-meta workflows produce no
 * "what miniOG did for you" narrative, so we skip them.
 */
function isMemoryWorthyWorkflow(intent: string): boolean {
  return intent !== 'CONVERSATIONAL' && intent !== 'NONE' && intent !== 'UNKNOWN' && intent !== 'MINIOG_DOSSIER';
}

async function addReaction(client: WebClient, channel: string, timestamp: string, name: string): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp, name });
  } catch (error) {
    logger.warn({ channel, timestamp, name, error: String(error) }, 'failed to add reaction (non-fatal)');
  }
}

async function removeReaction(client: WebClient, channel: string, timestamp: string, name: string): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp, name });
  } catch (error) {
    logger.warn({ channel, timestamp, name, error: String(error) }, 'failed to remove reaction (non-fatal)');
  }
}

function isTransientError(message: string): boolean {
  return /ETIMEDOUT|ECONNRESET|429|SlackApiError|timeout/i.test(message);
}

function extractSlackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const maybeData = (error as { data?: { error?: unknown } }).data;
  if (maybeData && typeof maybeData.error === 'string') {
    return maybeData.error;
  }
  return undefined;
}

async function postViaResponseUrl(params: { responseUrl: string; text: string; threadTs?: string }): Promise<void> {
  const { responseUrl, text, threadTs } = params;
  const payload: Record<string, unknown> = {
    response_type: 'in_channel',
    replace_original: false,
    text,
  };
  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  const response = await fetch(responseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`response_url post failed (${response.status}): ${body}`);
  }
}

function buildEventAwareClient(client: WebClient, event: SlackEventEnvelope): WebClient {
  if (!event.responseUrl) {
    return client;
  }

  const wrappedClient = Object.create(client) as WebClient;
  const originalPostMessage = client.chat.postMessage.bind(client.chat);
  const wrappedChat = Object.create(client.chat) as typeof client.chat;

  wrappedChat.postMessage = async (...args: Parameters<typeof client.chat.postMessage>) => {
    const payload = (args[0] ?? {}) as {
      channel?: string;
      thread_ts?: string;
      text?: string;
    };
    try {
      return await originalPostMessage(...args);
    } catch (error) {
      const errorCode = extractSlackErrorCode(error);
      const sameChannel = payload.channel === event.channelId;
      const sameThread = !payload.thread_ts || payload.thread_ts === event.threadTs;

      if (errorCode === 'not_in_channel' && sameChannel && sameThread && event.responseUrl) {
        await postViaResponseUrl({
          responseUrl: event.responseUrl,
          text: String(payload.text ?? ''),
          threadTs: payload.thread_ts ?? event.threadTs,
        });
        return {
          ok: true,
          ts: payload.thread_ts ?? event.threadTs,
          channel: event.channelId,
        } as Awaited<ReturnType<typeof client.chat.postMessage>>;
      }
      throw error;
    }
  };

  (wrappedClient as unknown as { chat: typeof client.chat }).chat = wrappedChat;
  return wrappedClient;
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
  const actionLines = actions
    .slice(0, 3)
    .map(action => `- ${action}`)
    .join('\n');
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

  logger.info(
    {
      eventId: event.eventId,
      channelId: event.channelId,
      threadTs: event.threadTs,
      reaction: event.reaction,
      sentiment,
      itemUserId: event.itemUserId ?? null,
    },
    'reaction feedback ingested',
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

function _startProactiveOpsFeed(client: WebClient): void {
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

function _startDailyDigestTicker(client: WebClient): void {
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

function _startIncidentCommanderFeed(client: WebClient): void {
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

async function enqueueSlackEvent(
  event: SlackEventEnvelope,
  client: WebClient,
  source: 'socket' | 'catchup' | 'launchpad',
): Promise<void> {
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
    'slack event received',
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
    logger.info(
      { eventId: event.eventId, channelId: event.channelId, eventTs: event.eventTs },
      'duplicate channel/eventTs ignored',
    );
    return;
  }

  // Thread-level dedup: skip if this thread already has a running/paused job
  const activeThreadJob = store.activeJobForThread(event.channelId, event.threadTs);
  if (activeThreadJob) {
    store.recordEvent(event.eventId, event.channelId, event.threadTs);
    logger.info(
      {
        eventId: event.eventId,
        channelId: event.channelId,
        threadTs: event.threadTs,
        activeJobId: activeThreadJob.id,
        activeJobStatus: activeThreadJob.status,
        activeJobWorkflow: activeThreadJob.workflow,
      },
      'skipped: thread already has an active job',
    );
    return;
  }

  // Paused-job follow-up: if a workflow paused asking the user to reply in
  // this thread (e.g. PR_REVIEW asking for a missing PR URL), the reply
  // arrives without an @miniOG mention and would otherwise be dropped by the
  // no-mention gate below. Decide here whether this event resumes a paused
  // job, so we can synthesize the mention after normalization.
  //
  // We can't trust jobs.workflow as the resume gate: owner mentions land in
  // that column as OWNER_AUTOPILOT even when the classifier later routed
  // them to PR_REVIEW. Read the actual pause cause from job_logs instead.
  const pausedJob = store.pausedJobForThread(event.channelId, event.threadTs);
  const pauseSignal = pausedJob && store.isPausedAwaitingPrUrl(pausedJob.id) ? 'pr_review_awaiting_url' : undefined;
  const resumeDecision = decidePausedResume({
    pausedJob: pausedJob ? { id: pausedJob.id, workflow: pausedJob.workflow } : undefined,
    pauseSignal,
    eventText: event.text ?? '',
  });

  const eventClient = buildEventAwareClient(client, event);

  // Add :eyes: reaction to signal processing has started
  await addReaction(client, event.channelId, event.eventTs, 'eyes');

  logger.info({ eventId: event.eventId }, 'fetching thread context for intake');
  const threadMessages = await fetchThreadContext(eventClient, event.channelId, event.threadTs).catch(() => []);
  const threadTexts = threadMessages.map(message => message.text);
  logger.info({ eventId: event.eventId, messages: threadMessages.length }, 'thread context fetched for intake');
  let task = normalizeTask(event, config, threadTexts);

  // If this event resumes a paused workflow that asked the user to reply
  // in-thread, synthesize the bot mention so the no-mention gate below does
  // not drop the reply, and mark the old paused job as superseded.
  if (resumeDecision.resume && resumeDecision.paused) {
    task = { ...task, mentionDetected: true, mentionType: 'bot' };
    store.markJob(resumeDecision.paused.id, 'SKIPPED', {
      result: {
        reason: 'resumed_by_followup',
        followupEventId: event.eventId,
        resumeReason: resumeDecision.reason,
      },
    });
    logger.info(
      {
        eventId: event.eventId,
        pausedJobId: resumeDecision.paused.id,
        pausedWorkflow: resumeDecision.paused.workflow,
        reason: resumeDecision.reason,
      },
      'paused-job follow-up: synthesized mention to resume in-thread',
    );
  }

  logger.info(
    {
      eventId: event.eventId,
      mentionDetected: task.mentionDetected,
      mentionType: task.mentionType,
      intent: task.intent,
    },
    'task normalized from slack event',
  );

  if (!task.mentionDetected) {
    logger.info({ eventId: event.eventId }, 'skip non-mention message');
    await removeReaction(client, event.channelId, event.eventTs, 'eyes');
    return;
  }

  // Policy engine check — block requests that violate critical or non-master rules
  const policyDecision = evaluatePolicy(event.userId, event.text, getAdminUserIds(config));
  if (!policyDecision.allowed) {
    logger.warn(
      { eventId: event.eventId, userId: event.userId, tier: policyDecision.tier, ruleId: policyDecision.ruleId },
      'request blocked by policy engine',
    );
    await eventClient.chat
      .postMessage({
        channel: event.channelId,
        thread_ts: event.threadTs,
        text: policyDecision.reason,
      })
      .catch(() => {});
    await removeReaction(client, event.channelId, event.eventTs, 'eyes');
    await addReaction(client, event.channelId, event.eventTs, 'no_entry_sign');
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
      learningNotes: learning.notes,
    },
    'learning engine evaluated task',
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
      learningNotes: learning.notes,
      eventTs: event.eventTs,
      ingestSource: event.ingestSource ?? 'socket',
      launchpadRequestId: event.launchpadRequestId ?? null,
    },
  });

  const abortController = new AbortController();
  registerActiveJob(jobId, abortController);

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
        'failed to persist workflow step log',
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
      learningNotes: learning.notes,
      threadMessages: threadMessages.length,
      ingestSource: event.ingestSource ?? 'socket',
      launchpadRequestId: event.launchpadRequestId ?? null,
    },
  });

  markLaunchpadJobCreated({
    event,
    jobId,
    store,
    logStep,
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
        // Hot-reload agent backend setting from DB before each workflow run
        // so that settings changes take effect without restarting the sidecar.
        const currentBackend = readAgentBackend(dbPath);
        setActiveBackend(currentBackend);

        const result = await agentCallContext.run({ jobId, store }, () =>
          routeTask({
            task: routedTask,
            config,
            slack: eventClient,
            store,
            jobId,
            logStep,
            signal: abortController.signal,
          }),
        );
        const hasPrInResult =
          result.result?.prUrl && typeof result.result.prUrl === 'string' && result.result.prUrl !== '';
        const diagnosis =
          result.status === 'FAILED' && !hasPrInResult
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
            client: eventClient,
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
          // For PAUSED jobs the workflow's resumeContext (if it set one) is the
          // payload that matters — it's what loadResumeContext + the sweeper
          // read. Fall back to result.result for legacy callers that PAUSE
          // without a resume context (e.g. desktop-routing on uncertain repo).
          store.markJob(jobId, 'PAUSED', {
            result: (result.resumeContext as Record<string, unknown> | undefined) ?? result.result,
          });
        } else if (result.status === 'SKIPPED') {
          store.markJob(jobId, 'SKIPPED', { result: result.result });
        } else {
          store.markJob(jobId, 'FAILED', { errorMessage: result.message, result: result.result });
        }

        try {
          const personalityMode = store.getPersonalityMode({
            channelId: event.channelId,
            userId: event.userId,
          });
          const repoName = typeof result.result?.repoName === 'string' ? result.result.repoName : undefined;
          const productKey = isMemoryWorthyWorkflow(routedTask.intent)
            ? (classifyProduct([event.text ?? '', result.message ?? '', JSON.stringify(result.result ?? {})])
                .selected ?? undefined)
            : undefined;
          store.recordLearningSignal({
            jobId,
            eventId: event.eventId,
            channelId: event.channelId,
            userId: event.userId,
            workflow: routedTask.intent,
            intent: task.intent,
            status: result.status,
            correctionApplied: learning.correctionApplied,
            errorKind: diagnosis?.errorKind,
            personalityMode,
            repo: repoName,
            product: productKey,
          });
          if (isMemoryWorthyWorkflow(routedTask.intent) && result.message) {
            const prUrl =
              typeof result.result?.prUrl === 'string' && result.result.prUrl ? result.result.prUrl : undefined;
            store.dossierStore().recordMemory({
              userId: event.userId,
              jobId,
              workflow: routedTask.intent,
              status: result.status,
              repo: repoName,
              prUrl,
              product: productKey,
              summary: result.message,
            });
          }
          store.dossierStore().invalidate(event.userId);
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

        await finalizeLaunchpadWorkflowResult({
          event,
          result,
          slack: eventClient,
          store,
          logStep,
        });

        unregisterActiveJob(jobId);

        // Swap :eyes: for outcome reaction. PAUSED gets a distinct emoji so a
        // glance at the thread tells you "parked, mention me to resume" rather
        // than the misleading :x: it used to share with cancelled/failed jobs.
        await removeReaction(client, event.channelId, event.eventTs, 'eyes');
        const outcomeReaction =
          result.status === 'SUCCESS' || result.status === 'SKIPPED'
            ? 'white_check_mark'
            : result.status === 'PAUSED'
              ? 'zzz'
              : 'x';
        await addReaction(client, event.channelId, event.eventTs, outcomeReaction);

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

    await eventClient.chat
      .postMessage({
        channel: event.channelId,
        thread_ts: event.threadTs,
        text: `${errorMessage}`,
      })
      .catch(() => {});

    if (diagnosis) {
      await postFailureDoctorHint({
        client: eventClient,
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

    unregisterActiveJob(jobId);
    notifyDesktop('Watchtower workflow failed', errorMessage);
    failLaunchpadWorkflow({
      event,
      errorMessage,
      store,
      logStep,
    });
    store.markJob(jobId, 'FAILED', { errorMessage });

    // Swap :eyes: for :x: on retry exhaustion
    await removeReaction(client, event.channelId, event.eventTs, 'eyes');
    await addReaction(client, event.channelId, event.eventTs, 'x');

    try {
      const personalityMode = store.getPersonalityMode({
        channelId: event.channelId,
        userId: event.userId,
      });
      const productKey = isMemoryWorthyWorkflow(routedTask.intent)
        ? (classifyProduct([event.text ?? '', errorMessage ?? '']).selected ?? undefined)
        : undefined;
      store.recordLearningSignal({
        jobId,
        eventId: event.eventId,
        channelId: event.channelId,
        userId: event.userId,
        workflow: routedTask.intent,
        intent: task.intent,
        status: 'FAILED',
        correctionApplied: learning.correctionApplied,
        errorKind: diagnosis?.errorKind,
        personalityMode,
        product: productKey,
      });
      if (isMemoryWorthyWorkflow(routedTask.intent) && errorMessage) {
        store.dossierStore().recordMemory({
          userId: event.userId,
          jobId,
          workflow: routedTask.intent,
          status: 'FAILED',
          product: productKey,
          summary: `Failed: ${errorMessage.slice(0, 280)}`,
        });
      }
      store.dossierStore().invalidate(event.userId);
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

    unregisterActiveJob(jobId);
    logger.error({ jobId, eventId: event.eventId, error: errorMessage }, 'unexpected processEvent failure');
    notifyDesktop('Watchtower job failure', errorMessage);
    failLaunchpadWorkflow({
      event,
      errorMessage,
      store,
      logStep,
    });
    store.markJob(jobId, 'FAILED', { errorMessage });

    // Swap :eyes: for :x: on unexpected failure
    await removeReaction(client, event.channelId, event.eventTs, 'eyes');
    await addReaction(client, event.channelId, event.eventTs, 'x');

    try {
      const personalityMode = store.getPersonalityMode({
        channelId: event.channelId,
        userId: event.userId,
      });
      const productKey = isMemoryWorthyWorkflow(routedTask.intent)
        ? (classifyProduct([event.text ?? '', errorMessage ?? '']).selected ?? undefined)
        : undefined;
      store.recordLearningSignal({
        jobId,
        eventId: event.eventId,
        channelId: event.channelId,
        userId: event.userId,
        workflow: routedTask.intent,
        intent: task.intent,
        status: 'FAILED',
        correctionApplied: learning.correctionApplied,
        errorKind: diagnosis?.errorKind,
        personalityMode,
        product: productKey,
      });
      if (isMemoryWorthyWorkflow(routedTask.intent) && errorMessage) {
        store.dossierStore().recordMemory({
          userId: event.userId,
          jobId,
          workflow: routedTask.intent,
          status: 'FAILED',
          product: productKey,
          summary: `Failed: ${errorMessage.slice(0, 280)}`,
        });
      }
      store.dossierStore().invalidate(event.userId);
    } catch {
      // ignore persistence failures in terminal error path
    }
  }
}

async function main(): Promise<void> {
  logger.info({ dbPath, maxConcurrentJobs: config.maxConcurrentJobs }, 'watchtower sidecar starting');
  cleanupStaleWorkspaces();

  // Boot the optional Obsidian-compatible vault writer. When disabled (or no
  // path configured), scheduleVaultRender calls become no-ops; the dossier
  // store stays unaware of which mode the operator is in.
  const vaultSettings = store.readVaultSettings();
  configureVaultWriter({
    store,
    vaultPath: vaultSettings.vaultPath,
    enabled: vaultSettings.vaultEnabled,
  });
  // Two-way edits: chokidar watches users/*.md and lifts Role/Notes back into
  // user_dossiers. No-op when vault is disabled.
  await configureVaultWatcher({
    store,
    vaultPath: vaultSettings.vaultPath,
    enabled: vaultSettings.vaultEnabled,
  }).catch(err => logger.warn({ err: String(err) }, 'vault watcher start failed'));

  // Phase C: nightly profile synthesizer. Ticks every 60s and runs once per
  // IST day (~midnight) for users with activity since the last run.
  // Bounded cost: skips users with <3 memories or last synthesis <12h ago,
  // concurrency capped at 2 LLM calls in flight.
  startProfileSynthesizerScheduler(store);

  // Mark any leftover RUNNING jobs as FAILED — their processes are gone after restart
  const orphaned = store.cleanupOrphanedRunningJobs();
  if (orphaned > 0) {
    logger.warn({ orphaned }, 'cleaned up orphaned RUNNING jobs from previous session');
  }

  const client = new SocketSlackClient(
    config,
    async (event, webClient) => {
      await enqueueSlackEvent(event, webClient as WebClient, 'socket');
    },
    async event => {
      await processReactionFeedback(event);
    },
  );

  process.on('SIGINT', () => {
    logger.info('received SIGINT');
    shutdownVaultWriter();
    void shutdownVaultWatcher();
    stopProfileSynthesizerScheduler();
    store.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('received SIGTERM');
    shutdownVaultWriter();
    void shutdownVaultWatcher();
    stopProfileSynthesizerScheduler();
    store.close();
    process.exit(0);
  });

  await client.start();
  logger.info('autonomous feed/digest/incident posting disabled; mention-triggered replies only');

  const refreshAccessGroups = async () => {
    const accessControl = getConfiguredAccessControl(config);
    for (const groupKey of Object.keys(accessControl.groups) as AccessGroupKey[]) {
      const group = accessControl.groups[groupKey];
      const handles = group.slackUserGroupHandle
        .split(',')
        .map(h => h.trim())
        .filter(Boolean);
      if (handles.length === 0) {
        continue;
      }

      const allMembers: string[] = [];
      for (const handle of handles) {
        try {
          const members = await resolveUserGroupMembers(client.webClient, handle);
          allMembers.push(...members);
        } catch (error) {
          logger.warn({ groupKey, handle, error: String(error) }, 'access group handle refresh failed');
        }
      }

      setResolvedGroupMembers({ config, groupKey, members: allMembers });
      logger.info(
        {
          groupKey,
          handles,
          memberCount: getConfiguredAccessControl(config).groups[groupKey].resolvedUserIds.length,
        },
        'access group resolved',
      );
    }
  };

  await refreshAccessGroups();
  setInterval(refreshAccessGroups, 30 * 60 * 1000);

  // Poll for cancel requests from the Watchtower UI (written to SQLite by Tauri)
  setInterval(() => {
    const pendingIds = store.popPendingCancels();
    for (const jobId of pendingIds) {
      const cancelled = cancelJob(jobId);
      if (cancelled) {
        store.markJob(jobId, 'CANCELLED', { errorMessage: 'Cancelled from Watchtower UI.' });
        logger.info({ jobId }, 'job cancelled from UI');
      }
    }
  }, 2000);

  // Sweep stale PAUSED jobs every 5 minutes. A job that's been paused for >24h
  // without a resume mention is treated as abandoned: marked FAILED so it
  // stops counting in dashboards / occupying paused-job listings. The
  // workspace under workspaces/<thread_ts> is left alone (it's per-thread, not
  // per-job, and a future task in the same thread may want to reuse it).
  const PAUSED_MAX_AGE_MIN = 24 * 60;
  setInterval(
    () => {
      try {
        const stale = store.stalePausedJobs(PAUSED_MAX_AGE_MIN);
        for (const job of stale) {
          store.markJob(job.id, 'FAILED', {
            errorMessage: `Idle timeout — paused for >${PAUSED_MAX_AGE_MIN / 60}h without a resume mention.`,
          });
          logger.info(
            { jobId: job.id, channelId: job.channelId, threadTs: job.threadTs },
            'stale PAUSED job swept to FAILED',
          );
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'paused-job sweeper tick failed');
      }
    },
    5 * 60 * 1000,
  );

  startMentionCatchup({
    webClient: client.webClient,
    config,
    store,
    enqueue: enqueueSlackEvent,
  });

  startLaunchpadRequestPoller({
    webClient: client.webClient,
    config,
    store,
    enqueue: async (event, webClient) => {
      await enqueueSlackEvent(event, webClient, 'launchpad');
    },
  });
}

main().catch(error => {
  logger.error({ error: String(error) }, 'watchtower sidecar crashed');
  notifyDesktop('Watchtower sidecar crash', String(error));
  process.exit(1);
});
