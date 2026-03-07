import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import type { JobStore } from '../state/jobStore.js';
import type { AppConfig, SlackEventEnvelope } from '../types/contracts.js';

const LAUNCHPAD_POLL_INTERVAL_MS = 5_000;

function buildLaunchpadEnvelope(params: {
  config: AppConfig;
  request: {
    id: string;
    ownerUserId: string;
    prompt: string;
  };
  channelId: string;
  anchorTs: string;
}): SlackEventEnvelope {
  const { config, request, channelId, anchorTs } = params;

  return {
    eventId: `launchpad:${request.id}:${anchorTs}`,
    channelId,
    channelType: 'im',
    threadTs: anchorTs,
    eventTs: anchorTs,
    userId: request.ownerUserId,
    text: `<@${config.botUserId}> ${request.prompt}`.trim(),
    ingestSource: 'launchpad',
    launchpadRequestId: request.id,
    rawEvent: {
      type: 'launchpad_request',
      requestId: request.id,
      ownerUserId: request.ownerUserId,
      prompt: request.prompt,
      anchorTs,
    },
  };
}

export async function runLaunchpadRequestPoller(params: {
  webClient: WebClient;
  config: AppConfig;
  store: JobStore;
  enqueue: (
    event: SlackEventEnvelope,
    client: WebClient,
    source: 'launchpad'
  ) => Promise<void>;
}): Promise<void> {
  const { webClient, config, store, enqueue } = params;
  const requests = store.claimPendingLaunchpadRequests();

  if (requests.length === 0) {
    return;
  }

  logger.info({ count: requests.length }, 'processing pending launchpad requests');

  for (const request of requests) {
    try {
      const dm = await webClient.conversations.open({
        users: request.ownerUserId,
      });
      const channelId = String(dm.channel?.id ?? '');
      if (!channelId) {
        throw new Error('launchpad DM open did not return a channel id');
      }

      const anchor = await webClient.chat.postMessage({
        channel: channelId,
        text: request.prompt,
      });
      const anchorTs = String(anchor.ts ?? '');
      if (!anchorTs) {
        throw new Error('launchpad anchor post did not return a timestamp');
      }

      store.markLaunchpadRequestQueued({
        id: request.id,
        slackChannelId: channelId,
        anchorTs,
      });

      const event = buildLaunchpadEnvelope({
        config,
        request,
        channelId,
        anchorTs,
      });

      await enqueue(event, webClient, 'launchpad');

      logger.info(
        {
          requestId: request.id,
          channelId,
          anchorTs,
        },
        'launchpad request converted into synthetic slack event'
      );
    } catch (error) {
      const errorMessage = `Launchpad request failed before execution: ${String(error)}`;
      store.markLaunchpadRequestFinished({
        id: request.id,
        status: 'FAILED',
        errorMessage,
      });

      logger.error(
        {
          requestId: request.id,
          error: String(error),
        },
        'launchpad request intake failed'
      );

      notifyDesktop('Watchtower miniOG launch failed', errorMessage);
    }
  }
}

export function startLaunchpadRequestPoller(params: {
  webClient: WebClient;
  config: AppConfig;
  store: JobStore;
  enqueue: (
    event: SlackEventEnvelope,
    client: WebClient,
    source: 'launchpad'
  ) => Promise<void>;
  pollIntervalMs?: number;
}): void {
  const poll = async (): Promise<void> => {
    try {
      await runLaunchpadRequestPoller(params);
    } catch (error) {
      logger.error({ error: String(error) }, 'launchpad request poller tick failed');
    }
  };

  void poll();
  setInterval(() => {
    void poll();
  }, params.pollIntervalMs ?? LAUNCHPAD_POLL_INTERVAL_MS);
}
