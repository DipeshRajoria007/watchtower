import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runInformationalWorkflow } from '../src/workflows/informationalWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';
import type { WebClient } from '@slack/web-api';

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

vi.mock('../src/slack/imageDownloader.js', () => ({
  downloadSlackImages: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/backends/registry.js', () => ({
  getBackend: vi.fn().mockReturnValue({ supportsImages: () => false }),
}));

vi.mock('../src/router/repoClassifier.js', () => ({
  classifyRepo: vi.fn().mockReturnValue({ selectedRepo: 'newton-web', confidence: 0.9, uncertain: false }),
}));

vi.mock('../src/workspaces/workspaceManager.js', () => ({
  resolveWorkspace: vi.fn((repoPath: string) => repoPath),
}));

function makeSlack() {
  return {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }) },
    users: { info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Test' } } }) },
  } as unknown as WebClient;
}

const config = {
  platformPolicy: 'macos_only' as const,
  bundleTargets: ['app', 'dmg'] as const,
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  coreDevSlackUserGroup: '',
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01',
  allowedChannelsForBugFix: ['C01'],
  repoPaths: { newtonWeb: '/code/newton-web', newtonApi: '/code/newton-api' },
  unknownTaskPolicy: 'desktop_only' as const,
  uncertainRepoPolicy: 'desktop_only' as const,
  unmappedPrRepoPolicy: 'desktop_only' as const,
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
};

describe('informationalWorkflow', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
  });

  it('calls codex and returns sanitized answer', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage:
        'The auth flow uses JWT tokens stored in cookies. Login hits /api/auth/login which validates credentials and returns a session token.',
      parsedJson: undefined,
    });

    const slack = makeSlack();
    const result = await runInformationalWorkflow({
      task: {
        event: {
          eventId: 'Ev1',
          channelId: 'C1',
          threadTs: '1.1',
          eventTs: '1.1',
          userId: 'U1',
          text: '<@UBOT1> how does the auth flow work?',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'INFORMATIONAL',
      },
      config,
      slack,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.workflow).toBe('INFORMATIONAL');
    expect(result.message).toContain('auth flow');
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it('returns FAILED when codex fails', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: false,
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: 'error',
      lastMessage: '',
      parsedJson: undefined,
    });

    const slack = makeSlack();
    const result = await runInformationalWorkflow({
      task: {
        event: {
          eventId: 'Ev2',
          channelId: 'C1',
          threadTs: '1.1',
          eventTs: '1.1',
          userId: 'U1',
          text: '<@UBOT1> what files handle login?',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'INFORMATIONAL',
      },
      config,
      slack,
    });

    expect(result.status).toBe('FAILED');
    expect(result.message).toBeTruthy();
  });

  it('returns fallback message when codex returns empty', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: undefined,
    });

    const slack = makeSlack();
    const result = await runInformationalWorkflow({
      task: {
        event: {
          eventId: 'Ev3',
          channelId: 'C1',
          threadTs: '1.1',
          eventTs: '1.1',
          userId: 'U1',
          text: '<@UBOT1> explain the pipeline',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'INFORMATIONAL',
      },
      config,
      slack,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('could not find a clear answer');
  });

  it('posts answer to correct Slack thread', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'Answer here',
      parsedJson: undefined,
    });

    const slack = makeSlack();
    await runInformationalWorkflow({
      task: {
        event: {
          eventId: 'Ev4',
          channelId: 'C_TARGET',
          threadTs: '999.888',
          eventTs: '999.888',
          userId: 'U1',
          text: '<@UBOT1> where is the config?',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'INFORMATIONAL',
      },
      config,
      slack,
    });

    expect(slack.chat.postMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C_TARGET', thread_ts: '999.888' }),
    );
  });
});
