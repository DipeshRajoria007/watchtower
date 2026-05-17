/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { isDeployRequest } from '../src/router/intentParser.js';
import { normalizeTask } from '../src/router/intentParser.js';
import type { AppConfig, NormalizedTask, SlackEventEnvelope } from '../src/types/contracts.js';
import { runDeployWorkflow } from '../src/workflows/deployWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/github/githubAuth.js', () => ({
  resolveGithubTokenForCodex: vi.fn().mockResolvedValue(undefined),
}));

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

describe('runDeployWorkflow idempotency on Slack post failure', () => {
  function deployTask(): NormalizedTask {
    return {
      event: {
        eventId: 'Ev-deploy',
        channelId: 'C-DEPLOY',
        threadTs: '999.88',
        eventTs: '999.88',
        userId: 'UOWNER1',
        text: '<@UBOT1> deploy newton-web to prod',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: true,
      isCoreDevAuthor: true,
      intent: 'DEPLOY',
    };
  }

  it('runs the deploy codex exactly once even when the final Slack reply throws transiently', async () => {
    // Regression for #287: a transient slack.chat.postMessage failure (ETIMEDOUT etc.)
    // used to escape the workflow and trip the index.ts retry loop, which re-entered
    // the deploy workflow and called runCodex again. A flaky notification could
    // duplicate a production deploy up to 3 times.
    vi.mocked(runCodex).mockReset();
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'Deploy succeeded. v1.2.3 live.',
      parsedJson: undefined,
    });

    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, ts: '1.0' }) // ack post ("Deploying newton-web to production...")
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const slack = { chat: { postMessage } } as any;
    const result = await runDeployWorkflow({ task: deployTask(), config, slack });

    // The deploy itself must run exactly once.
    expect(runCodex).toHaveBeenCalledTimes(1);
    // The workflow must NOT throw — that's what would trigger the index.ts retry loop.
    expect(result.status).toBe('SUCCESS');
    expect(result.slackPosted).toBe(false);
    // The ack + 3 final-reply attempts = 4 calls total.
    expect(postMessage).toHaveBeenCalledTimes(4);
  });

  it('returns SUCCESS and slackPosted=true when the final reply lands on a later retry', async () => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'Deploy succeeded.',
      parsedJson: undefined,
    });

    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, ts: '1.0' }) // ack post
      .mockRejectedValueOnce(new Error('ECONNRESET')) // first reply attempt
      .mockResolvedValueOnce({ ok: true, ts: '2.0' }); // second attempt succeeds

    const slack = { chat: { postMessage } } as any;
    const result = await runDeployWorkflow({ task: deployTask(), config, slack });

    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('SUCCESS');
    expect(result.slackPosted).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(3);
  });
});
