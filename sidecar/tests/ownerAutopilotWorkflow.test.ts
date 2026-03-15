import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runOwnerAutopilotWorkflow } from '../src/workflows/ownerAutopilotWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
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
  unknownTaskPolicy: 'desktop_only' as const,
  uncertainRepoPolicy: 'desktop_only' as const,
  unmappedPrRepoPolicy: 'desktop_only' as const,
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
};

describe('ownerAutopilotWorkflow', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
  });

  it('replies directly to lightweight owner presence ping without running codex', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const result = await runOwnerAutopilotWorkflow({
      task: {
        event: {
          eventId: 'EvOwnerPing',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> you there?',
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
    expect(result.message.toLowerCase()).toMatch(/(here|online|present)/);
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('runs codex for broad owner prompts instead of pausing for clarification', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        status: 'success',
        summary: 'Done. Applied a chaotic but safe tweak as requested.',
        actions: ['Applied tweak'],
        prUrl: '',
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
          eventId: 'EvOwner0',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> do something cursed with my laptop',
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
    expect(result.message).toContain('Applied a chaotic but safe tweak');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Applied a chaotic but safe tweak'),
      })
    );
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it('normalizes legacy needs_clarification output to no_action without pausing', async () => {
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

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('Which repository should I use');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('No action required.'),
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

  it('returns paused with human retry prompt when codex fails', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: false,
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: 'fatal',
      lastMessage: '',
      parsedJson: undefined,
    });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const result = await runOwnerAutopilotWorkflow({
      task: {
        event: {
          eventId: 'EvOwner3',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> merge PR #123 in newton-web',
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
    expect(result.message).toContain('I hit an execution issue right now');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining('exit='),
      })
    );
    expect(runCodex).toHaveBeenCalledTimes(2);
  });

  it('uses primary plain-text output without a relaxed retry when strict JSON parsing fails after success', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'Tagged the people who were already mentioned in that PR review thread.',
      parsedJson: undefined,
    });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const result = await runOwnerAutopilotWorkflow({
      task: {
        event: {
          eventId: 'EvOwnerPlainText',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> follow up in the existing PR review thread',
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
    expect(result.message).toContain('Tagged the people');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Tagged the people'),
      })
    );
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it('does not run relaxed retry when structured output is already parsed', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage:
        '```json\n{"status":"success","summary":"Applied the requested follow-up.","actions":["posted update"],"prUrl":""}\n```',
      parsedJson: {
        status: 'success',
        summary: 'Applied the requested follow-up.',
        actions: ['posted update'],
        prUrl: '',
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
          eventId: 'EvOwnerStructured',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> share a follow-up',
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
    expect(result.message).toContain('Applied the requested follow-up');
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it('falls back to relaxed plain-text mode when strict JSON output fails', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: 'schema mismatch',
        lastMessage: '',
        parsedJson: undefined,
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: 'Created local repository `testing-mini-og` in /Users/dipesh/code.',
        parsedJson: undefined,
      });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const result = await runOwnerAutopilotWorkflow({
      task: {
        event: {
          eventId: 'EvOwner4',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> create a testing-mini-og repo inside code folder on my machine',
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
    expect(result.message).toContain('Created local repository');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Created local repository'),
      })
    );
    expect(runCodex).toHaveBeenCalledTimes(2);
  });
});
