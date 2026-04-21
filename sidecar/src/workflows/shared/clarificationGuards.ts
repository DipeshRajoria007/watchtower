import type { WebClient } from '@slack/web-api';
import { fetchThreadContext } from '../../slack/threadContext.js';
import type { WorkflowStepLogger } from '../../types/contracts.js';

export type ClarificationOutcome =
  | { outcome: 'answered'; answer: string; answererId: string }
  | { outcome: 'timeout' }
  | { outcome: 'cancelled' };

export const DEFAULT_IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_NUDGE_AFTER_MS = 30 * 60 * 1000;

export async function waitForClarificationWithIdle(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  allowedUserIds: string[];
  promptTs: string;
  logStep: WorkflowStepLogger;
  botUserId?: string;
  idleTimeoutMs?: number;
  nudgeAfterMs?: number;
  nudgeText?: string;
  signal?: AbortSignal;
}): Promise<ClarificationOutcome> {
  const {
    slack,
    channelId,
    threadTs,
    allowedUserIds,
    promptTs,
    logStep,
    botUserId,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    nudgeAfterMs = DEFAULT_NUDGE_AFTER_MS,
    nudgeText,
    signal,
  } = params;

  const pollIntervalMs = 5_000;
  const startedAt = Date.now();
  let nudged = false;

  while (true) {
    if (signal?.aborted) {
      return { outcome: 'cancelled' };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= idleTimeoutMs) {
      logStep({
        stage: 'pipeline.clarification.timeout',
        message: `No answer within ${Math.round(idleTimeoutMs / 60_000)} min — pausing.`,
        level: 'WARN',
      });
      return { outcome: 'timeout' };
    }

    if (!nudged && elapsed >= nudgeAfterMs && nudgeText) {
      try {
        await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: nudgeText });
      } catch {
        // best-effort nudge
      }
      nudged = true;
    }

    await sleep(pollIntervalMs, signal);

    let messages: Array<{ text: string; user: string; ts: string }>;
    try {
      messages = await fetchThreadContext(slack, channelId, threadTs);
    } catch {
      continue;
    }

    const candidates = messages.filter(m => m.ts > promptTs && m.user !== botUserId);
    for (const reply of candidates) {
      if (!allowedUserIds.includes(reply.user)) continue;
      const answer = reply.text.trim();
      if (!answer) continue;

      const lowered = answer.toLowerCase();
      if (lowered === 'cancel' || lowered === 'stop' || lowered === 'abort') {
        logStep({
          stage: 'pipeline.clarification.cancelled',
          message: `<@${reply.user}> cancelled: "${answer}"`,
        });
        return { outcome: 'cancelled' };
      }

      logStep({
        stage: 'pipeline.clarification.answered',
        message: `<@${reply.user}> answered: "${answer}"`,
      });
      return { outcome: 'answered', answer, answererId: reply.user };
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}
