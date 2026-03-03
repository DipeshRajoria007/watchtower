import { App, LogLevel } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, SlackEventEnvelope } from '../types/contracts.js';
import { logger } from '../logging/logger.js';

type SlackEventHandler = (event: SlackEventEnvelope, client: WebClient) => Promise<void>;

export class SocketSlackClient {
  private app: App;
  private readonly config: AppConfig;
  private readonly onEvent: SlackEventHandler;

  constructor(config: AppConfig, onEvent: SlackEventHandler) {
    this.config = config;
    this.onEvent = onEvent;
    this.app = new App({
      token: config.slackBotToken,
      appToken: config.slackAppToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    });

    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.app.event('app_mention', async ({ event, body, client }) => {
      const normalized = this.normalizeEnvelope(
        event as unknown as Record<string, unknown>,
        body as unknown as Record<string, unknown>
      );
      logger.info(
        {
          component: 'slack',
          eventType: 'app_mention',
          eventId: normalized.eventId,
          channelId: normalized.channelId,
          threadTs: normalized.threadTs,
        },
        'received app_mention event'
      );
      await this.onEvent(normalized, client);
    });

    this.app.event('message', async ({ event, body, client }) => {
      const normalized = this.normalizeEnvelope(
        event as unknown as Record<string, unknown>,
        body as unknown as Record<string, unknown>
      );
      logger.info(
        {
          component: 'slack',
          eventType: 'message',
          eventId: normalized.eventId,
          channelId: normalized.channelId,
          threadTs: normalized.threadTs,
          subtype: normalized.messageSubtype ?? null,
        },
        'received message event'
      );
      await this.onEvent(normalized, client);
    });
  }

  private normalizeEnvelope(event: Record<string, unknown>, body: Record<string, unknown>): SlackEventEnvelope {
    const channelId = String(event.channel ?? '');
    const eventTs = String(event.ts ?? body.event_ts ?? '');
    const threadTs = String(event.thread_ts ?? event.ts ?? '');
    const text = String(event.text ?? '');
    const userId = String(event.user ?? '');
    const messageSubtype = event.subtype ? String(event.subtype) : undefined;
    const eventId = String(body.event_id ?? `${channelId}:${eventTs}`);

    return {
      eventId,
      channelId,
      threadTs,
      eventTs,
      userId,
      text,
      messageSubtype,
      rawEvent: event,
    };
  }

  async start(): Promise<void> {
    logger.info({ component: 'slack' }, 'starting socket mode');
    await this.app.start();
    logger.info({ component: 'slack' }, 'socket mode started');
  }

  get webClient() {
    return this.app.client;
  }
}
