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
  assertThreadParentExists: vi.fn().mockResolvedValue(true),
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

  it('rewrites a "fix is done" reply when investigation findings are pending on this thread', async () => {
    // Regression for RCA on Slack thread p1779086230428739 (2026-05-18). If the
    // conversational workflow runs in a thread with pending investigation_findings
    // and the agent still produces a completion-claim reply (despite the truth
    // guardrail in the prompt), the workflow must rewrite the message to a
    // steer ("on it") before posting — never tell the user "the fix is done"
    // when no code work happened in this turn.
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'All exports exist. The fix is done.',
      parsedJson: undefined,
    });

    const slack = makeSlack();
    const logStep = vi.fn();
    const investigationStore = {
      getForThread: vi.fn().mockReturnValue({
        threadTs: '1.1',
        channelId: 'C1',
        jobId: 'job-prior',
        repoName: 'newton-web',
        summary: 'prior RCA exists',
      }),
    };

    const result = await runConversationalWorkflow({
      task: {
        event: {
          eventId: 'EvSteer',
          channelId: 'C1',
          threadTs: '1.1',
          eventTs: '1.1',
          userId: 'U1',
          text: '<@UBOT1> yes',
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
      logStep,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      investigationStore: investigationStore as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).not.toMatch(/fix is done|all exports exist/i);
    expect(result.message).toMatch(/on it|will share the PR/i);
    expect(slack.chat.postMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('On it'),
      }),
    );
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'conversational.investigation_pending.steer_applied',
        data: expect.objectContaining({
          originalReply: 'All exports exist. The fix is done.',
        }),
      }),
    );
  });

  it('leaves a normal reply untouched even when investigation findings are pending', async () => {
    // The guardrail must only kick in for completion-claim text. Normal
    // steering replies pass through unchanged.
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'Sounds good — let me know if you want me to fix it.',
      parsedJson: undefined,
    });

    const slack = makeSlack();
    const investigationStore = {
      getForThread: vi.fn().mockReturnValue({
        threadTs: '1.1',
        channelId: 'C1',
        jobId: 'job-prior',
        repoName: 'newton-web',
        summary: 'prior RCA exists',
      }),
    };

    const result = await runConversationalWorkflow({
      task: {
        event: {
          eventId: 'EvNoSteer',
          channelId: 'C1',
          threadTs: '1.1',
          eventTs: '1.1',
          userId: 'U1',
          text: '<@UBOT1> just acknowledging',
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      investigationStore: investigationStore as any,
    });

    expect(result.message).toContain('Sounds good');
  });

  it('does not apply the steer when no investigation findings exist', async () => {
    // Casual chat in a thread with no pending findings must not be rewritten,
    // even if the reply mentions "fix" or other guardrail-adjacent words.
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'The fix is done in my dreams, but no — chatting only here.',
      parsedJson: undefined,
    });

    const slack = makeSlack();
    const investigationStore = {
      getForThread: vi.fn().mockReturnValue(undefined),
    };

    const result = await runConversationalWorkflow({
      task: {
        event: {
          eventId: 'EvCasual',
          channelId: 'C1',
          threadTs: '1.1',
          eventTs: '1.1',
          userId: 'U1',
          text: '<@UBOT1> banter',
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      investigationStore: investigationStore as any,
    });

    expect(result.message).toContain('in my dreams');
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
