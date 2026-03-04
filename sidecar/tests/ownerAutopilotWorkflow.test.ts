import { describe, expect, it, vi } from 'vitest';
import { runOwnerAutopilotWorkflow } from '../src/workflows/ownerAutopilotWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
}));

vi.mock('../src/slack/threadContext.js', () => ({
  fetchThreadContext: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/github/githubAuth.js', () => ({
  resolveGithubTokenForCodex: vi.fn().mockResolvedValue(undefined),
  githubAuthModeHint: vi.fn().mockReturnValue('none'),
}));

vi.mock('../src/notify/desktopNotifier.js', () => ({
  notifyDesktop: vi.fn(),
}));

const config = {
  platformPolicy: 'macos_only' as const,
  bundleTargets: ['app', 'dmg'] as const,
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
  unknownTaskPolicy: 'desktop_only' as const,
  uncertainRepoPolicy: 'desktop_only' as const,
  unmappedPrRepoPolicy: 'desktop_only' as const,
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
};

describe('ownerAutopilotWorkflow', () => {
  it('pauses and asks one clarifying question when codex returns needs_clarification', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        status: 'needs_clarification',
        summary: 'Which repository should I use for this request: newton-web or newton-api?',
        actions: [],
        prUrl: '',
        confidence: 0.31,
      },
    });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const result = await runOwnerAutopilotWorkflow({
      task: {
        event: {
          eventId: 'EvOwner1',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> do it',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: true,
        intent: 'OWNER_AUTOPILOT',
      },
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('PAUSED');
    expect(result.message).toContain('Which repository should I use');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Which repository should I use'),
      })
    );
  });

  it('strips legacy success prefix and posts clean human summary', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        status: 'success',
        summary: 'Owner request success. Merged PR #7638 into master using squash merge.',
        actions: ['Merged PR #7638'],
        prUrl: 'https://github.com/Newton-School/newton-web/pull/7638',
      },
    });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const result = await runOwnerAutopilotWorkflow({
      task: {
        event: {
          eventId: 'EvOwner2',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> merge this',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: true,
        intent: 'OWNER_AUTOPILOT',
      },
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Merged PR #7638 into master using squash merge.'),
      })
    );
    expect(slack.chat.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Owner request success'),
      })
    );
  });
});
