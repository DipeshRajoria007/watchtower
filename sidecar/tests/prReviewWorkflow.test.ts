import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPrReviewWorkflow } from '../src/workflows/prReviewWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';
import { resolveGithubTokenForCodex } from '../src/github/githubAuth.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
}));

vi.mock('../src/github/githubAuth.js', () => ({
  resolveGithubTokenForCodex: vi.fn().mockResolvedValue(undefined),
  githubAuthModeHint: vi.fn().mockReturnValue('none'),
}));

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

describe('prReviewWorkflow', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(resolveGithubTokenForCodex).mockResolvedValue(undefined);
  });

  it('asks for PR URL and pauses when PR context is missing', async () => {
    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({ messages: [{ text: 'please review this' }] }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev1',
        channelId: 'C1',
        threadTs: '123.45',
        eventTs: '123.45',
        userId: 'U123',
        text: '<@UBOT1> please review',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      intent: 'PR_REVIEW',
    };

    const result = await runPrReviewWorkflow({
      task,
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('PAUSED');
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('skips with no-new-changes message when PR head SHA is unchanged', async () => {
    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [{ text: 'please review this https://github.com/Newton-School/newton-web/pull/123' }],
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev2',
        channelId: 'C1',
        threadTs: '888.99',
        eventTs: '888.99',
        userId: 'U123',
        text: '<@UBOT1> review again https://github.com/Newton-School/newton-web/pull/123',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      intent: 'PR_REVIEW',
      prContext: {
        url: 'https://github.com/Newton-School/newton-web/pull/123',
        owner: 'Newton-School',
        repo: 'newton-web',
        number: 123,
      },
    };

    const result = await runPrReviewWorkflow({
      task,
      config,
      slack: slack as any,
      store: {
        findLatestReviewedPrHeadSha: () => ({
          jobId: 'previous-job',
          prHeadSha: 'deadbeef',
          updatedAt: '2026-03-03T08:00:00.000Z',
        }),
      } as any,
      resolvePrHeadSha: async () => 'deadbeef',
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.message).toContain('No new changes');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'No new commits since the last review. Same diff, same verdict. Push an update and I will rerun.',
      })
    );
  });

  it('tags requester and skips when PR org is outside allowed scope', async () => {
    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [{ text: 'review https://github.com/facebook/react/pull/35961/files' }],
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev3',
        channelId: 'C1',
        threadTs: '777.88',
        eventTs: '777.88',
        userId: 'U_SCOPE',
        text: '<@UBOT1> review this https://github.com/facebook/react/pull/35961/files',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      intent: 'PR_REVIEW',
      prContext: {
        url: 'https://github.com/facebook/react/pull/35961',
        owner: 'facebook',
        repo: 'react',
        number: 35961,
      },
    };

    const result = await runPrReviewWorkflow({
      task,
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.slackPosted).toBe(true);
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '<@U_SCOPE> this PR is outside supported review scope. I can review `Newton-School/newton-web` and `Newton-School/newton-api`.',
      })
    );
  });

  it('tags requester and skips when PR repo is not newton-web/newton-api', async () => {
    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [{ text: 'review https://github.com/Newton-School/random-repo/pull/11' }],
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev4',
        channelId: 'C1',
        threadTs: '666.77',
        eventTs: '666.77',
        userId: 'U_SCOPE2',
        text: '<@UBOT1> review this https://github.com/Newton-School/random-repo/pull/11',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      intent: 'PR_REVIEW',
      prContext: {
        url: 'https://github.com/Newton-School/random-repo/pull/11',
        owner: 'Newton-School',
        repo: 'random-repo',
        number: 11,
      },
    };

    const result = await runPrReviewWorkflow({
      task,
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.slackPosted).toBe(true);
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '<@U_SCOPE2> this PR is outside supported review scope. I can review `Newton-School/newton-web` and `Newton-School/newton-api`.',
      })
    );
  });

  it('uses the high-reasoning profile for in-scope PR review execution', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        status: 'success',
        summary: 'Two findings posted on the PR.',
        prUrl: 'https://github.com/Newton-School/newton-web/pull/901',
      },
    });

    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [{ text: 'please review https://github.com/Newton-School/newton-web/pull/901' }],
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev5',
        channelId: 'C1',
        threadTs: '555.66',
        eventTs: '555.66',
        userId: 'U_REVIEW',
        text: '<@UBOT1> review this https://github.com/Newton-School/newton-web/pull/901',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      intent: 'PR_REVIEW',
      prContext: {
        url: 'https://github.com/Newton-School/newton-web/pull/901',
        owner: 'Newton-School',
        repo: 'newton-web',
        number: 901,
      },
    };

    const result = await runPrReviewWorkflow({
      task,
      config,
      slack: slack as any,
      store: {
        findLatestReviewedPrHeadSha: () => undefined,
        getChannelPolicyPack: () => undefined,
      } as any,
      resolvePrHeadSha: async () => 'cafebabe',
    });

    expect(result.status).toBe('SUCCESS');
    expect(runCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/Users/dipesh/code/newton-web',
        model: 'gpt-5.4',
        reasoningEffort: 'xhigh',
      })
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'PR review in progress. I will drop findings here shortly.',
      })
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('PR review done. Two findings posted on the PR.'),
      })
    );
  });
});
