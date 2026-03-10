import type { AppConfig, NormalizedTask, PrContext, SlackEventEnvelope, WorkflowIntent } from '../types/contracts.js';
import { hasDevAssistPrefix, hasNaturalDevAssistAlias } from './devAssistParser.js';

const PR_REVIEW_KEYWORDS = [
  /review/i,
  /pr\b/i,
  /pull request/i,
  /code review/i,
];

const BUG_FIX_KEYWORDS = [
  /bug/i,
  /fix/i,
  /broken/i,
  /error/i,
  /failing/i,
  /regression/i,
  /crash/i,
  /issue/i,
];

const GITHUB_PR_REGEX = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

export function detectMention(
  text: string,
  config: AppConfig,
  channelType?: string
): { detected: boolean; type: 'bot' | 'owner' | 'none' } {
  if (!text) {
    if (channelType === 'im') {
      return { detected: true, type: 'bot' };
    }
    return { detected: false, type: 'none' };
  }

  const botMention = `<@${config.botUserId}>`;
  if (text.includes(botMention)) {
    return { detected: true, type: 'bot' };
  }

  for (const ownerId of config.ownerSlackUserIds) {
    if (text.includes(`<@${ownerId}>`)) {
      return { detected: true, type: 'owner' };
    }
  }

  // In a direct message to the bot (channel_type=im), explicit mention markup is usually absent.
  // Treat any non-empty DM message as an implicit bot mention.
  if (channelType === 'im') {
    return { detected: true, type: 'bot' };
  }

  return { detected: false, type: 'none' };
}

export function extractPrContext(texts: string[]): PrContext | undefined {
  for (const text of texts) {
    if (!text) {
      continue;
    }
    const matches = [...text.matchAll(GITHUB_PR_REGEX)];
    if (matches.length > 0) {
      const match = matches[0];
      return {
        url: match[0],
        owner: match[1],
        repo: match[2],
        number: Number(match[3]),
      };
    }
  }
  return undefined;
}

function inferIntent(
  event: SlackEventEnvelope,
  config: AppConfig,
  mention: { detected: boolean; type: 'bot' | 'owner' | 'none' }
): WorkflowIntent {
  // Any explicit wt/watchtower prefix is always routed to dev-assist, even for owners.
  if (mention.detected && hasDevAssistPrefix(event.text ?? '')) {
    return 'DEV_ASSIST';
  }

  // Natural-language status/capability prompts should route to dev-assist as lightweight aliases.
  if (mention.detected && hasNaturalDevAssistAlias(event.text ?? '')) {
    return 'DEV_ASSIST';
  }

  const isOwnerAuthor = config.ownerSlackUserIds.includes(event.userId);
  if (mention.detected && mention.type === 'bot' && isOwnerAuthor) {
    return 'OWNER_AUTOPILOT';
  }

  const text = event.text ?? '';
  const isReview = PR_REVIEW_KEYWORDS.some(regex => regex.test(text));
  if (isReview) {
    return 'PR_REVIEW';
  }

  const isBugFix = BUG_FIX_KEYWORDS.some(regex => regex.test(text));
  if (isBugFix && config.allowedChannelsForBugFix.includes(event.channelId)) {
    return 'BUG_FIX';
  }

  return 'UNKNOWN';
}

export function normalizeTask(
  event: SlackEventEnvelope,
  config: AppConfig,
  threadTexts: string[] = []
): NormalizedTask {
  const mention = detectMention(event.text, config, event.channelType);
  const isOwnerAuthor = config.ownerSlackUserIds.includes(event.userId);
  const prContext = extractPrContext([event.text, ...threadTexts]);

  return {
    event,
    mentionDetected: mention.detected,
    mentionType: mention.type,
    isOwnerAuthor,
    intent: inferIntent(event, config, mention),
    prContext,
  };
}
