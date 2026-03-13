import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBugFixWorkflow } from '../src/workflows/bugFixWorkflow.js';
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
  multiAgentEnabled: false,
};

describe('bugFixWorkflow', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(resolveGithubTokenForCodex).mockResolvedValue(undefined);
  });

  it('returns skipped when repo classification is uncertain', async () => {
    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({ messages: [{ text: 'UI and API both fail in different ways' }] }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev1',
        channelId: 'C01H25RNLJH',
        threadTs: '123.45',
        eventTs: '123.45',
        userId: 'U123',
        text: '<@UBOT1> bug fix needed for frontend and backend',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      intent: 'BUG_FIX',
    };

    const result = await runBugFixWorkflow({
      task,
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('SKIPPED');
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('uses the high-reasoning profile for confident bug-fix execution', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        status: 'success',
        summary: 'Fixed the failing React hydration flow and opened a PR.',
        prUrl: 'https://github.com/Newton-School/newton-web/pull/902',
        branch: 'codex/fix-hydration',
        tests: ['npm test'],
      },
    });

    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [{ text: 'frontend React page throws hydration error in browser' }],
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev2',
        channelId: 'C01H25RNLJH',
        threadTs: '222.33',
        eventTs: '222.33',
        userId: 'U_BUG',
        text: '<@UBOT1> frontend React page throws hydration error in browser',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      intent: 'BUG_FIX',
    };

    const result = await runBugFixWorkflow({
      task,
      config,
      slack: slack as any,
      store: {
        getChannelPolicyPack: () => undefined,
      } as any,
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
        text: 'Bug-fix run started in newton-web.',
      })
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Bug fix wrapped. Fixed the failing React hydration flow and opened a PR.'),
      })
    );
  });
});
