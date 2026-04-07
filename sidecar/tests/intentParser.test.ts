import { describe, expect, it } from 'vitest';
import { detectMention, extractPrContext, normalizeTask } from '../src/router/intentParser.js';
import type { AppConfig, SlackEventEnvelope } from '../src/types/contracts.js';

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  coreDevSlackUserGroup: '',
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01H25RNLJH',
  allowedChannelsForBugFix: ['C01H25RNLJH', 'C02BUGS'],
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
};

const baseEvent: SlackEventEnvelope = {
  eventId: 'Ev1',
  channelId: 'C01H25RNLJH',
  threadTs: '123.45',
  eventTs: '123.45',
  userId: 'U123',
  text: '',
  rawEvent: {},
};

describe('intentParser', () => {
  it('detects direct bot and indirect owner mentions', () => {
    expect(detectMention('ping <@UBOT1>', config)).toEqual({ detected: true, type: 'bot' });
    expect(detectMention('ping <@UOWNER1>', config)).toEqual({ detected: true, type: 'indirect' });
    expect(detectMention('no mention', config)).toEqual({ detected: false, type: 'none' });
  });

  it('detects configured core-dev user-group mentions as indirect triggers', () => {
    const groupConfig = {
      ...config,
      coreDevSlackUserGroupId: 'SCOREDEV1',
    };

    expect(detectMention('ping <!subteam^SCOREDEV1>', groupConfig)).toEqual({
      detected: true,
      type: 'indirect',
    });
    expect(detectMention('ping <!subteam^SOTHERTEAM>', groupConfig)).toEqual({
      detected: false,
      type: 'none',
    });
  });

  it('treats direct-message text as implicit bot mention', () => {
    expect(detectMention('can you do this?', config, 'im')).toEqual({ detected: true, type: 'bot' });
    expect(detectMention('', config, 'im')).toEqual({ detected: true, type: 'bot' });
    expect(detectMention('can you do this?', config, 'channel')).toEqual({ detected: false, type: 'none' });
  });

  it('extracts PR context from text', () => {
    const result = extractPrContext(['https://github.com/Newton-School/newton-web/pull/123']);
    expect(result?.owner).toBe('Newton-School');
    expect(result?.repo).toBe('newton-web');
    expect(result?.number).toBe(123);
  });

  it('normalizes PR-containing message to OWNER_AUTOPILOT (AI classifier refines in router)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> please review this PR https://github.com/Newton-School/newton-web/pull/123',
      },
      config,
      [],
    );

    // normalizeTask returns OWNER_AUTOPILOT as preliminary intent;
    // the AI classifier in routeTask refines it to PR_REVIEW.
    expect(task.intent).toBe('OWNER_AUTOPILOT');
    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(false);
    expect(task.prContext?.repo).toBe('newton-web');
  });

  it('routes any bot-mentioned bug request to owner-autopilot', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> fix this bug please',
      },
      config,
      [],
    );

    expect(task.intent).toBe('OWNER_AUTOPILOT');

    const otherChannel = normalizeTask(
      {
        ...baseEvent,
        channelId: 'COTHER',
        text: '<@UBOT1> fix this bug please',
      },
      config,
      [],
    );

    expect(otherChannel.intent).toBe('OWNER_AUTOPILOT');
  });

  it('returns OWNER_AUTOPILOT for PR URL in any channel (AI refines in router)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        channelId: 'CANY123',
        text: '<@UBOT1> review https://github.com/Newton-School/newton-web/pull/22',
      },
      config,
      [],
    );

    expect(task.intent).toBe('OWNER_AUTOPILOT');
    expect(task.mentionDetected).toBe(true);
    expect(task.prContext?.number).toBe(22);
  });

  it('routes owner-authored bot mention to owner-autopilot', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> fix this quickly and push',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(true);
    expect(task.intent).toBe('OWNER_AUTOPILOT');
  });

  it('routes owner-authored DM to owner-autopilot without explicit mention markup', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        channelId: 'D12345',
        channelType: 'im',
        userId: 'UOWNER1',
        text: 'create a folder for me',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.mentionType).toBe('bot');
    expect(task.intent).toBe('OWNER_AUTOPILOT');
  });

  it('routes explicit wt commands to dev-assist workflow', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> wt help',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.intent).toBe('DEV_ASSIST');
  });

  it('routes natural-language capability queries to dev-assist workflow', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> what did you learn?',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(true);
    expect(task.intent).toBe('DEV_ASSIST');
  });

  it('keeps owner-autopilot routing for owner chatter that is not an alias', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> this queue is cursed today',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(true);
    expect(task.intent).toBe('OWNER_AUTOPILOT');
  });

  it('routes prefixed unknown wt command to dev-assist instead of owner-autopilot', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> wt policy import frontend',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(true);
    expect(task.intent).toBe('DEV_ASSIST');
  });

  it('routes bare PR mention without review context to owner-autopilot', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> can you give me the PR link',
      },
      config,
      [],
    );

    expect(task.intent).toBe('OWNER_AUTOPILOT');
  });

  it('registers core-dev group PR review requests as indirect mentions with PR context', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<!subteam^SCOREDEV1> please review and merge https://github.com/Newton-School/newton-web/pull/7866',
      },
      {
        ...config,
        coreDevSlackUserGroupId: 'SCOREDEV1',
      },
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.mentionType).toBe('indirect');
    expect(task.intent).toBe('UNKNOWN');
    expect(task.prContext?.number).toBe(7866);
  });

  it('extracts PR context even though intent stays OWNER_AUTOPILOT (AI refines in router)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> https://github.com/Newton-School/newton-web/pull/99',
      },
      config,
      [],
    );

    expect(task.intent).toBe('OWNER_AUTOPILOT');
    expect(task.prContext?.number).toBe(99);
  });

  it('routes numbered wt command from owner to dev-assist', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '1. <@UBOT1> wt policy import frontend',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(true);
    expect(task.intent).toBe('DEV_ASSIST');
  });

  it('sets isCoreDevAuthor true for owners (owners are always core-dev)', () => {
    const task = normalizeTask({ ...baseEvent, userId: 'UOWNER1', text: '<@UBOT1> do something' }, config, []);
    expect(task.isOwnerAuthor).toBe(true);
    expect(task.isCoreDevAuthor).toBe(true);
  });

  it('sets isCoreDevAuthor true for core-dev non-owner users', () => {
    const coreDevConfig = {
      ...config,
      coreDevSlackUserIds: ['UOWNER1', 'UCOREDEV1'],
    };
    const task = normalizeTask({ ...baseEvent, userId: 'UCOREDEV1', text: '<@UBOT1> do something' }, coreDevConfig, []);
    expect(task.isOwnerAuthor).toBe(false);
    expect(task.isCoreDevAuthor).toBe(true);
  });

  it('sets isCoreDevAuthor false for regular users', () => {
    const task = normalizeTask({ ...baseEvent, userId: 'URANDOM', text: '<@UBOT1> do something' }, config, []);
    expect(task.isOwnerAuthor).toBe(false);
    expect(task.isCoreDevAuthor).toBe(false);
  });
});
