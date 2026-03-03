import type { WebClient } from '@slack/web-api';
import { detectMention } from '../router/intentParser.js';
import { logger } from '../logging/logger.js';
import type { AppConfig, SlackEventEnvelope } from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';

const CATCHUP_STATE_KEY = 'mention_catchup_cursor_ts';
const CATCHUP_INTERVAL_MS = 2 * 60 * 1000;
const CATCHUP_LOOKBACK_SECONDS = 60 * 60 * 24;
const CATCHUP_MAX_MESSAGES_PER_CHANNEL = 200;
const NON_ACTIONABLE_SUBTYPES = new Set(['message_changed', 'message_deleted', 'bot_message']);

type CatchupDeps = {
  webClient: WebClient;
  config: AppConfig;
  store: JobStore;
  enqueue: (event: SlackEventEnvelope, client: WebClient, source: 'socket' | 'catchup') => Promise<void>;
};

export function startMentionCatchup(deps: CatchupDeps): void {
  void runMentionCatchup(deps);
  setInterval(() => {
    void runMentionCatchup(deps);
  }, CATCHUP_INTERVAL_MS);
}

async function runMentionCatchup(deps: CatchupDeps): Promise<void> {
  const { webClient, config, store, enqueue } = deps;
  const nowTs = Math.floor(Date.now() / 1000);
  const storedCursorRaw = store.getState(CATCHUP_STATE_KEY);
  const storedCursor = storedCursorRaw ? Number(storedCursorRaw) : 0;
  const oldestTs = Number.isFinite(storedCursor) && storedCursor > 0 ? Math.max(0, storedCursor - 5) : nowTs - CATCHUP_LOOKBACK_SECONDS;

  logger.info(
    {
      component: 'slack-catchup',
      oldestTs,
      cursorTs: storedCursor || null,
    },
    'starting missed mention catch-up scan'
  );

  const channelIds = await discoverChannels(webClient, store, config);
  logger.info(
    {
      component: 'slack-catchup',
      channels: channelIds.length,
    },
    'resolved channels for missed mention catch-up'
  );

  let recovered = 0;
  let scannedMessages = 0;
  let maxSeenTs = oldestTs;

  for (const channelId of channelIds) {
    const historyMessages = await fetchChannelHistory(webClient, channelId, oldestTs);
    if (historyMessages.length === 0) {
      continue;
    }

    const ordered = historyMessages
      .filter(message => typeof message.ts === 'string' && message.ts.length > 0)
      .sort((a, b) => Number(a.ts) - Number(b.ts));

    for (const message of ordered) {
      const eventTs = String(message.ts ?? '');
      if (!eventTs) {
        continue;
      }

      scannedMessages += 1;
      maxSeenTs = Math.max(maxSeenTs, toEpochSeconds(eventTs));

      const subtype = message.subtype ? String(message.subtype) : '';
      if (subtype && NON_ACTIONABLE_SUBTYPES.has(subtype)) {
        continue;
      }

      const text = String(message.text ?? '');
      const userId = String(message.user ?? '');
      if (!text || !userId || userId === config.botUserId) {
        continue;
      }

      const mention = detectMention(text, config);
      if (!mention.detected) {
        continue;
      }

      const replayEventId = `replay:${channelId}:${eventTs}`;
      if (store.hasEvent(replayEventId) || store.hasJobForEventTs(channelId, eventTs)) {
        continue;
      }

      const threadTs = String(message.thread_ts ?? message.ts ?? '');
      const alreadyResponded = await hasBotResponseAfterMention(webClient, channelId, threadTs, eventTs, config.botUserId);
      if (alreadyResponded) {
        store.recordEvent(replayEventId, channelId, threadTs);
        continue;
      }

      const envelope: SlackEventEnvelope = {
        eventId: replayEventId,
        channelId,
        threadTs,
        eventTs,
        userId,
        text,
        messageSubtype: subtype || undefined,
        rawEvent: message as Record<string, unknown>,
      };

      await enqueue(envelope, webClient, 'catchup');
      recovered += 1;
    }
  }

  const nextCursor = Math.max(nowTs, maxSeenTs);
  store.setState(CATCHUP_STATE_KEY, String(nextCursor));

  logger.info(
    {
      component: 'slack-catchup',
      recovered,
      scannedMessages,
      nextCursor,
    },
    'completed missed mention catch-up scan'
  );
}

async function discoverChannels(client: WebClient, store: JobStore, config: AppConfig): Promise<string[]> {
  const channelSet = new Set<string>([...store.listKnownChannels(500), ...config.allowedChannelsForBugFix]);

  let cursor: string | undefined;
  try {
    do {
      const response = await client.users.conversations({
        cursor,
        limit: 200,
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
      });

      const channels = response.channels ?? [];
      for (const channel of channels) {
        if (channel.id) {
          channelSet.add(channel.id);
        }
      }

      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (error) {
    logger.warn(
      {
        component: 'slack-catchup',
        error: String(error),
      },
      'failed to enumerate channels via users.conversations; falling back to known channels'
    );
  }

  return Array.from(channelSet);
}

async function fetchChannelHistory(
  client: WebClient,
  channelId: string,
  oldestTs: number
): Promise<Array<Record<string, unknown>>> {
  const oldest = String(oldestTs);
  const messages: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;

  try {
    do {
      const response = await client.conversations.history({
        channel: channelId,
        oldest,
        inclusive: false,
        limit: CATCHUP_MAX_MESSAGES_PER_CHANNEL,
        cursor,
      });

      for (const message of response.messages ?? []) {
        messages.push(message as unknown as Record<string, unknown>);
      }

      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (error) {
    logger.warn(
      {
        component: 'slack-catchup',
        channelId,
        error: String(error),
      },
      'failed to fetch channel history during missed mention catch-up'
    );
  }

  return messages;
}

async function hasBotResponseAfterMention(
  client: WebClient,
  channelId: string,
  threadTs: string,
  mentionTs: string,
  botUserId: string
): Promise<boolean> {
  try {
    const response = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      inclusive: true,
      limit: 200,
    });
    const mentionEpoch = toEpochSeconds(mentionTs);
    for (const message of response.messages ?? []) {
      const ts = String(message.ts ?? '');
      if (!ts) {
        continue;
      }
      if (String(message.user ?? '') === botUserId && toEpochSeconds(ts) > mentionEpoch) {
        return true;
      }
    }
    return false;
  } catch (error) {
    logger.warn(
      {
        component: 'slack-catchup',
        channelId,
        threadTs,
        error: String(error),
      },
      'failed to inspect thread replies while checking missed mention response status'
    );
    return true;
  }
}

function toEpochSeconds(ts: string): number {
  const value = Number(ts);
  return Number.isFinite(value) ? value : 0;
}

