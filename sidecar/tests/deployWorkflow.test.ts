import { describe, expect, it } from 'vitest';
import { isDeployRequest } from '../src/router/intentParser.js';
import { normalizeTask } from '../src/router/intentParser.js';
import type { AppConfig, SlackEventEnvelope } from '../src/types/contracts.js';

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
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
  agentBackend: 'claude-code',
  prReviewTimeoutMs: 120_000,
  bugFixTimeoutMs: 120_000,
  pmTaskTimeoutMs: 120_000,
};

const baseEvent: SlackEventEnvelope = {
  eventId: 'Ev1',
  channelId: 'C01H25RNLJH',
  threadTs: '123.45',
  eventTs: '123.45',
  userId: 'UOWNER1',
  text: '',
  rawEvent: {},
};

describe('isDeployRequest', () => {
  it('matches "deploy newton-web to prod"', () => {
    expect(isDeployRequest('<@UBOT1> deploy newton-web to prod')).toBe(true);
  });

  it('matches "deploy to production"', () => {
    expect(isDeployRequest('<@UBOT1> deploy to production')).toBe(true);
  });

  it('matches "deploy prod"', () => {
    expect(isDeployRequest('<@UBOT1> deploy prod')).toBe(true);
  });

  it('matches "ship newton-web to production"', () => {
    expect(isDeployRequest('<@UBOT1> ship newton-web to production')).toBe(true);
  });

  it('matches "release newton web to prod"', () => {
    expect(isDeployRequest('<@UBOT1> release newton web to prod')).toBe(true);
  });

  it('matches "push to prod"', () => {
    expect(isDeployRequest('<@UBOT1> push to prod')).toBe(true);
  });

  it('matches "deploy newton-web" without explicit prod mention', () => {
    expect(isDeployRequest('<@UBOT1> deploy newton-web')).toBe(true);
  });

  it('matches "deploy the frontend to prod"', () => {
    expect(isDeployRequest('<@UBOT1> deploy the frontend to prod')).toBe(true);
  });

  it('does not match "deploy" alone without target or app', () => {
    expect(isDeployRequest('<@UBOT1> deploy')).toBe(false);
  });

  it('does not match unrelated messages', () => {
    expect(isDeployRequest('<@UBOT1> fix the login bug')).toBe(false);
  });

  it('does not match "deploy" in unrelated context', () => {
    expect(isDeployRequest('<@UBOT1> how does the deploy pipeline work?')).toBe(false);
  });
});

describe('normalizeTask routes DEPLOY deterministically', () => {
  it('routes "deploy newton-web to prod" as DEPLOY', () => {
    const task = normalizeTask({ ...baseEvent, text: '<@UBOT1> deploy newton-web to prod' }, config, []);
    expect(task.intent).toBe('DEPLOY');
  });

  it('routes "deploy to production" as DEPLOY', () => {
    const task = normalizeTask({ ...baseEvent, text: '<@UBOT1> deploy to production' }, config, []);
    expect(task.intent).toBe('DEPLOY');
  });

  it('routes "ship prod" as DEPLOY', () => {
    const task = normalizeTask({ ...baseEvent, text: '<@UBOT1> ship prod' }, config, []);
    expect(task.intent).toBe('DEPLOY');
  });

  it('does not route "fix the deploy script" as DEPLOY', () => {
    const task = normalizeTask({ ...baseEvent, text: '<@UBOT1> fix the deploy script' }, config, []);
    expect(task.intent).not.toBe('DEPLOY');
  });

  it('prioritizes DEV_ASSIST prefix over DEPLOY', () => {
    const task = normalizeTask({ ...baseEvent, text: '<@UBOT1> wt deploy prod' }, config, []);
    expect(task.intent).toBe('DEV_ASSIST');
  });
});
