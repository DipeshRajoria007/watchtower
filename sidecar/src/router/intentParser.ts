import type {
  AppConfig,
  MiniogSubcommand,
  NormalizedTask,
  PrContext,
  SlackEventEnvelope,
  WorkflowIntent,
} from '../types/contracts.js';
import { getAdminUserIds } from '../access/control.js';
import { isDossierForgetField, isDossierRole } from '../state/dossierStore.js';
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

/**
 * Parse a `/miniog <subcommand>` style message into a structured subcommand.
 * Returns null if the text is not a recognized dossier subcommand.
 *
 * Recognized forms (case-insensitive, leading bot mention tolerated):
 *   whoami
 *   set-role <pm|dev|designer|ops>
 *   forget <role|tone|notes|project_affinity|metrics|all> [confirm]
 */
export function parseMiniogSubcommand(text: string): MiniogSubcommand | null {
  if (!text) return null;
  const stripped = text
    .replace(/<@[^>]+>/g, ' ')
    .trim()
    .toLowerCase();
  if (!stripped) return null;
  const tokens = stripped.split(/\s+/);
  const head = tokens[0];

  if (head === 'whoami') return { kind: 'whoami' };

  if (head === 'set-role') {
    const role = tokens[1];
    if (role && isDossierRole(role)) return { kind: 'set-role', role };
    return null;
  }

  if (head === 'forget') {
    const field = tokens[1];
    if (!field || !isDossierForgetField(field)) return null;
    if (field === 'all') {
      const confirmed = tokens[2] === 'confirm';
      return { kind: 'forget', field: 'all', confirmed };
    }
    return { kind: 'forget', field, confirmed: true };
  }

  return null;
}

function inferIntent(
  event: SlackEventEnvelope,
  config: AppConfig,
  mention: { detected: boolean; type: 'bot' | 'owner' | 'none' },
): { intent: WorkflowIntent; miniogSubcommand?: MiniogSubcommand } {
  // Dossier subcommands (whoami / set-role / forget) take precedence over every other route
  // when the bot is mentioned. They are read-only or operator-self-edit commands and
  // must not bleed into the AI classifier.
  if (mention.detected) {
    const sub = parseMiniogSubcommand(event.text ?? '');
    if (sub) return { intent: 'MINIOG_DOSSIER', miniogSubcommand: sub };
  }

  // Any explicit wt/watchtower prefix is always routed to dev-assist, even for owners.
  if (mention.detected && hasDevAssistPrefix(event.text ?? '')) {
    return { intent: 'DEV_ASSIST' };
  }

  // Natural-language status/capability prompts should route to dev-assist as lightweight aliases.
  if (mention.detected && hasNaturalDevAssistAlias(event.text ?? '')) {
    return { intent: 'DEV_ASSIST' };
  }

  // Deterministic deploy detection — routed before the AI classifier.
  if (mention.detected && isDeployRequest(event.text ?? '')) {
    return { intent: 'DEPLOY' };
  }

  // Intent classification for PR_REVIEW vs OWNER_AUTOPILOT is handled by the
  // AI classifier in routeTask. Here we return OWNER_AUTOPILOT as the default
  // for any bot mention that is not a DEV_ASSIST command.

  // Any bot mention (owner or non-owner) routes to OWNER_AUTOPILOT.
  // The workflow itself determines trust level based on ownerSlackUserIds.
  if (mention.detected && mention.type === 'bot') {
    return { intent: 'OWNER_AUTOPILOT' };
  }

  return { intent: 'UNKNOWN' };
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
  const inferred = inferIntent(event, config, mention);

  return {
    event,
    mentionDetected: mention.detected,
    mentionType: mention.type,
    isOwnerAuthor,
    isCoreDevAuthor,
    intent: inferred.intent,
    prContext,
    miniogSubcommand: inferred.miniogSubcommand,
  };
}
