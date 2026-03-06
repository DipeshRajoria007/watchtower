import { describe, expect, it } from 'vitest';
import { detectMention, extractPrContext, normalizeTask } from '../src/router/intentParser.js';
import type { AppConfig, SlackEventEnvelope } from '../src/types/contracts.js';

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01H25RNLJH',
  allowedChannelsForBugFix: ['C01H25RNLJH', 'C02BUGS'],
  repoPaths: {
    newtonWeb: '/Users/dipesh/code/newton-web',
    newtonApi: '/Users/dipesh/code/newton-api',
  },
  workflowTimeouts: {
    prReviewMs: 720000,
    bugFixMs: 2700000,
  },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
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
  it('detects bot and owner mentions', () => {
    expect(detectMention('ping <@UBOT1>', config)).toEqual({ detected: true, type: 'bot' });
    expect(detectMention('ping <@UOWNER1>', config)).toEqual({ detected: true, type: 'owner' });
    expect(detectMention('no mention', config)).toEqual({ detected: false, type: 'none' });
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

  it('classifies PR review intent', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> please review this PR https://github.com/Newton-School/newton-web/pull/123',
      },
      config,
      [],
    );

    expect(task.intent).toBe('PR_REVIEW');
    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(false);
    expect(task.prContext?.repo).toBe('newton-web');
  });

  it('classifies bug-fix intent only for allowed channel', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> fix this bug please',
      },
      config,
      [],
    );

    expect(task.intent).toBe('BUG_FIX');

    const secondAllowed = normalizeTask(
      {
        ...baseEvent,
        channelId: 'C02BUGS',
        text: '<@UBOT1> fix this bug please',
      },
      config,
      [],
    );

    expect(secondAllowed.intent).toBe('BUG_FIX');

    const nonAllowed = normalizeTask(
      {
        ...baseEvent,
        channelId: 'COTHER',
        text: '<@UBOT1> fix this bug please',
      },
      config,
      [],
    );

    expect(nonAllowed.intent).toBe('UNKNOWN');
  });

  it('classifies PR review in any channel when mentioned', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        channelId: 'CANY123',
        text: '<@UBOT1> review https://github.com/Newton-School/newton-web/pull/22',
      },
      config,
      [],
    );

    expect(task.intent).toBe('PR_REVIEW');
    expect(task.mentionDetected).toBe(true);
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
});
