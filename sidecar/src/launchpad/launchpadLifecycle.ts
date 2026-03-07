import type { WebClient } from '@slack/web-api';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import type { SlackEventEnvelope, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';

type LaunchpadStore = {
  markLaunchpadRequestRunning: (input: { id: string; jobId: string }) => void;
  markLaunchpadRequestFinished: (input: {
    id: string;
    status: 'SUCCESS' | 'FAILED' | 'PAUSED' | 'SKIPPED';
    result?: Record<string, unknown>;
    errorMessage?: string;
  }) => void;
};

function fallbackCompletionText(message: string): string {
  const trimmed = message.trim();
  return trimmed || 'miniOG task finished.';
}

export function markLaunchpadJobCreated(params: {
  event: SlackEventEnvelope;
  jobId: string;
  store: LaunchpadStore;
  logStep?: WorkflowStepLogger;
}): void {
  const { event, jobId, store, logStep } = params;
  if (!event.launchpadRequestId) {
    return;
  }

  store.markLaunchpadRequestRunning({
    id: event.launchpadRequestId,
    jobId,
  });

  logStep?.({
    stage: 'launchpad.request.running',
    message: 'Linked launchpad request to job execution.',
    data: {
      requestId: event.launchpadRequestId,
      jobId,
    },
  });
}

export async function finalizeLaunchpadWorkflowResult(params: {
  event: SlackEventEnvelope;
  result: WorkflowResult;
  slack: WebClient;
  store: LaunchpadStore;
  logStep?: WorkflowStepLogger;
}): Promise<void> {
  const { event, result, slack, store, logStep } = params;
  if (!event.launchpadRequestId) {
    return;
  }

  let fallbackPosted = false;
  if (!result.slackPosted) {
    const text = fallbackCompletionText(result.message);
    try {
      await slack.chat.postMessage({
        channel: event.channelId,
        thread_ts: event.threadTs,
        text,
      });
      fallbackPosted = true;
      logStep?.({
        stage: 'launchpad.slack.fallback_posted',
        message: 'Posted fallback completion reply for launchpad task.',
        data: {
          requestId: event.launchpadRequestId,
          status: result.status,
        },
      });
    } catch (error) {
      logStep?.({
        stage: 'launchpad.slack.fallback_failed',
        message: 'Failed to post fallback completion reply for launchpad task.',
        level: 'WARN',
        data: {
          requestId: event.launchpadRequestId,
          error: String(error),
        },
      });
    }
  }

  store.markLaunchpadRequestFinished({
    id: event.launchpadRequestId,
    status: result.status,
    result: result.result,
    errorMessage: result.status === 'FAILED' ? result.message : undefined,
  });

  logStep?.({
    stage: 'launchpad.request.completed',
    message: 'Marked launchpad request with terminal workflow status.',
    data: {
      requestId: event.launchpadRequestId,
      status: result.status,
      slackPosted: result.slackPosted || fallbackPosted,
    },
  });

  if (result.status === 'SUCCESS') {
    notifyDesktop('Watchtower miniOG complete', fallbackCompletionText(result.message));
    logStep?.({
      stage: 'launchpad.notify.success',
      message: 'Emitted success notification for launchpad miniOG task.',
      data: {
        requestId: event.launchpadRequestId,
      },
    });
  }
}

export function failLaunchpadWorkflow(params: {
  event: SlackEventEnvelope;
  errorMessage: string;
  store: LaunchpadStore;
  logStep?: WorkflowStepLogger;
}): void {
  const { event, errorMessage, store, logStep } = params;
  if (!event.launchpadRequestId) {
    return;
  }

  store.markLaunchpadRequestFinished({
    id: event.launchpadRequestId,
    status: 'FAILED',
    errorMessage,
  });

  logStep?.({
    stage: 'launchpad.request.failed',
    message: 'Marked launchpad request as failed.',
    level: 'WARN',
    data: {
      requestId: event.launchpadRequestId,
      errorMessage,
    },
  });
}
