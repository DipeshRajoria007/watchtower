import { detectMention } from '../router/intentParser.js';
import type { AppConfig } from '../types/contracts.js';

const ALWAYS_IGNORED_MESSAGE_SUBTYPES = new Set(['message_changed', 'message_deleted']);

export function extractSlackActorId(event: Record<string, unknown>): string {
  const userId = typeof event.user === 'string' ? event.user.trim() : '';
  if (userId) {
    return userId;
  }

  const botId = typeof event.bot_id === 'string' ? event.bot_id.trim() : '';
  if (botId) {
    return `bot:${botId}`;
  }

  const appId = typeof event.app_id === 'string' ? event.app_id.trim() : '';
  if (appId) {
    return `app:${appId}`;
  }

  return '';
}

export function shouldIgnoreSlackMessage(params: {
  messageSubtype?: string;
  text?: string;
  channelType?: string;
  config: AppConfig;
}): boolean {
  const { messageSubtype, text = '', channelType, config } = params;
  if (!messageSubtype) {
    return false;
  }

  if (ALWAYS_IGNORED_MESSAGE_SUBTYPES.has(messageSubtype)) {
    return true;
  }

  if (messageSubtype !== 'bot_message') {
    return false;
  }

  return !detectMention(text, config, channelType).detected;
}
