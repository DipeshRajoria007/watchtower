import { describe, expect, it } from 'vitest';
import { extractSlackActorId, shouldIgnoreSlackMessage } from '../src/slack/intakeGuards.js';
import type { AppConfig } from '../src/types/contracts.js';

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  coreDevSlackUserGroup: 'core-dev',
  coreDevSlackUserGroupId: 'SCOREDEV1',
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01H25RNLJH',
  allowedChannelsForBugFix: ['C01H25RNLJH'],
  repoPaths: {
    newtonWeb: '/Users/dipesh/code/newton-web',
    newtonApi: '/Users/dipesh/code/newton-api',
  },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
  agentBackend: 'codex',
  prReviewTimeoutMs: 720000,
  bugFixTimeoutMs: 2700000,
  pmTaskTimeoutMs: 600000,
};

describe('intakeGuards', () => {
  it('extracts the human actor when present', () => {
    expect(extractSlackActorId({ user: 'U123', bot_id: 'B456' })).toBe('U123');
  });

  it('falls back to bot/app actor ids for bot-authored messages', () => {
    expect(extractSlackActorId({ bot_id: 'B456' })).toBe('bot:B456');
    expect(extractSlackActorId({ app_id: 'A789' })).toBe('app:A789');
  });

  it('ignores generic bot messages but keeps actionable group-trigger bot messages', () => {
    expect(
      shouldIgnoreSlackMessage({
        messageSubtype: 'bot_message',
        text: 'build succeeded',
        config,
      }),
    ).toBe(true);

    expect(
      shouldIgnoreSlackMessage({
        messageSubtype: 'bot_message',
        text: '<!subteam^SCOREDEV1> Please review and merge https://github.com/Newton-School/newton-web/pull/7866',
        config,
      }),
    ).toBe(false);
  });

  it('always ignores message edits and deletes', () => {
    expect(
      shouldIgnoreSlackMessage({
        messageSubtype: 'message_changed',
        text: '<!subteam^SCOREDEV1> hi',
        config,
      }),
    ).toBe(true);
  });
});
