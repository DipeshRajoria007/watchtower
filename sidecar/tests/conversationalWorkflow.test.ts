import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runConversationalWorkflow } from '../src/workflows/conversationalWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';
import type { WebClient } from '@slack/web-api';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/slack/threadContext.js', () => ({
  fetchThreadContext: vi.fn().mockResolvedValue([]),
}));

function makeSlack() {
  return {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }) },
  } as unknown as WebClient;
}

const config = {
  platformPolicy: 'macos_only' as const,
  bundleTargets: ['app', 'dmg'] as const,
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
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

describe('conversationalWorkflow', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
  });

  it('replies to presence pings without AI call', async () => {
    const slack = makeSlack();
    const result = await runConversationalWorkflow({
      task: {
        event: {
          eventId: 'Ev1',
          channelId: 'C1',
          threadTs: '1.1',
          eventTs: '1.1',
          userId: 'U1',
          text: '<@UBOT1> hi',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'CONVERSATIONAL',
      },
      config,
      slack,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.workflow).toBe('CONVERSATIONAL');
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('calls codex for non-ping conversational messages', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'Doing great, thanks for asking!',
      parsedJson: undefined,
    });

    const slack = makeSlack();
    const result = await runConversationalWorkflow({
      task: {
        event: {
          eventId: 'Ev2',
          channelId: 'C1',
          threadTs: '1.1',
          eventTs: '1.1',
          userId: 'U1',
          text: '<@UBOT1> how are you doing today?',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'CONVERSATIONAL',
      },
      config,
      slack,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('Doing great');
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it('returns fallback reply when codex fails', async () => {
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
    const result = await runConversationalWorkflow({
      task: {
        event: {
          eventId: 'Ev3',
          channelId: 'C1',
          threadTs: '1.1',
          eventTs: '1.1',
          userId: 'U1',
          text: '<@UBOT1> thanks!',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'CONVERSATIONAL',
      },
      config,
      slack,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toBeTruthy();
  });

  it('posts reply to correct channel and thread', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'Reply here',
      parsedJson: undefined,
    });

    const slack = makeSlack();
    await runConversationalWorkflow({
      task: {
        event: {
          eventId: 'Ev4',
          channelId: 'C_TARGET',
          threadTs: '999.888',
          eventTs: '999.888',
          userId: 'U1',
          text: '<@UBOT1> whats up?',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'CONVERSATIONAL',
      },
      config,
      slack,
    });

    expect(slack.chat.postMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C_TARGET', thread_ts: '999.888' }),
    );
  });
});
