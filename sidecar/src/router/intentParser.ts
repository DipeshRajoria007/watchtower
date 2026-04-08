import type { AppConfig, NormalizedTask, PrContext, SlackEventEnvelope, WorkflowIntent } from '../types/contracts.js';
import { getAdminUserIds } from '../access/control.js';
import { hasDevAssistPrefix, hasNaturalDevAssistAlias } from './devAssistParser.js';

const GITHUB_PR_REGEX = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

/**
 * Deterministic check: does the message ask to deploy newton-web to production?
 * This runs before the AI classifier so deploy requests are never misrouted.
 */
export function isDeployRequest(text: string): boolean {
  const normalized = text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();

  // Must contain a deploy verb
  const hasDeployVerb = /\b(deploy|ship|release|push to prod|push prod)\b/.test(normalized);
  if (!hasDeployVerb) return false;

  // Must reference production target
  const hasProdTarget = /\b(prod|production)\b/.test(normalized);
  // Must reference the app (or be unambiguous enough with just "deploy prod")
  const hasAppRef = /\b(newton[- ]?web|newton[- ]?school|frontend)\b/.test(normalized);

  // "deploy to prod" / "deploy prod" is unambiguous enough even without app name
  // "deploy newton-web" without "prod" is also valid (prod is the only deploy target)
  return hasProdTarget || hasAppRef;
}

export function detectMention(
  text: string,
  config: AppConfig,
  channelType?: string,
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
  mention: { detected: boolean; type: 'bot' | 'owner' | 'none' },
): WorkflowIntent {
  // Any explicit wt/watchtower prefix is always routed to dev-assist, even for owners.
  if (mention.detected && hasDevAssistPrefix(event.text ?? '')) {
    return 'DEV_ASSIST';
  }

  // Natural-language status/capability prompts should route to dev-assist as lightweight aliases.
  if (mention.detected && hasNaturalDevAssistAlias(event.text ?? '')) {
    return 'DEV_ASSIST';
  }

  // Deterministic deploy detection — routed before the AI classifier.
  if (mention.detected && isDeployRequest(event.text ?? '')) {
    return 'DEPLOY';
  }

  // Intent classification for PR_REVIEW vs OWNER_AUTOPILOT is handled by the
  // AI classifier in routeTask. Here we return OWNER_AUTOPILOT as the default
  // for any bot mention that is not a DEV_ASSIST command.

  // Any bot mention (owner or non-owner) routes to OWNER_AUTOPILOT.
  // The workflow itself determines trust level based on ownerSlackUserIds.
  if (mention.detected && mention.type === 'bot') {
    return 'OWNER_AUTOPILOT';
  }

  return 'UNKNOWN';
}

export function normalizeTask(
  event: SlackEventEnvelope,
  config: AppConfig,
  threadTexts: string[] = [],
): NormalizedTask {
  const mention = detectMention(event.text, config, event.channelType);
  const isOwnerAuthor = config.ownerSlackUserIds.includes(event.userId);
  const isCoreDevAuthor = getAdminUserIds(config).includes(event.userId);
  const prContext = extractPrContext([event.text, ...threadTexts]);

  return {
    event,
    mentionDetected: mention.detected,
    mentionType: mention.type,
    isOwnerAuthor,
    isCoreDevAuthor,
    intent: inferIntent(event, config, mention),
    prContext,
  };
}
