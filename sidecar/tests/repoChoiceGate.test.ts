/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForRepoChoice } from '../src/agents/pipeline.js';
import { runCodex } from '../src/codex/runCodex.js';
import { fetchThreadContext } from '../src/slack/threadContext.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/slack/threadContext.js', () => ({
  fetchThreadContext: vi.fn(),
  assertThreadParentExists: vi.fn().mockResolvedValue(true),
}));

const mockRunCodex = runCodex as unknown as ReturnType<typeof vi.fn>;
const mockFetchThread = fetchThreadContext as unknown as ReturnType<typeof vi.fn>;

function makeSlack() {
  const postMessage = vi.fn().mockResolvedValue({ ts: 'post.1' });
  return {
    chat: { postMessage },
  } as any;
}

describe('waitForRepoChoice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRunCodex.mockReset();
    mockFetchThread.mockReset();
  });

  async function advancePollCycles(n: number) {
    for (let i = 0; i < n; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
  }

  it('resolves to newton-web on short-circuit regex match for "web"', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'web' }]);

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(1);
    const result = await promise;

    expect(result.outcome).toBe('newton-web');
    expect(result.approverId).toBe('UADMIN');
    // Short-circuit means classifier model was never called.
    expect(mockRunCodex).not.toHaveBeenCalled();
  });

  it('resolves to newton-api on "newton-api" shorthand', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'newton-api' }]);

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(1);
    expect((await promise).outcome).toBe('newton-api');
  });

  it('uses the AI classifier for non-shorthand replies', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'the python one, django side' }]);
    mockRunCodex.mockResolvedValueOnce({
      ok: true,
      parsedJson: { intent: 'api', reasoning: 'python/django signals backend' },
    });

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(1);
    expect((await promise).outcome).toBe('newton-api');
    expect(mockRunCodex).toHaveBeenCalledTimes(1);
  });

  it('ignores replies from non-admin users and waits for an admin', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'USTRANGER', text: 'api' }]).mockResolvedValueOnce([
      { ts: 'post.2', user: 'USTRANGER', text: 'api' },
      { ts: 'post.3', user: 'UADMIN', text: 'web' },
    ]);

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(2);
    expect((await promise).outcome).toBe('newton-web');

    // Non-admin got nudged once.
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Only admins can pick the target repo'),
      }),
    );
  });

  it('returns "cancelled" when admin says "cancel"', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'cancel' }]);

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(1);
    expect((await promise).outcome).toBe('cancelled');
  });

  it('keeps waiting when the admin reply is classified as "unclear"', async () => {
    const slack = makeSlack();
    mockFetchThread
      .mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'not sure yet' }])
      .mockResolvedValueOnce([
        { ts: 'post.2', user: 'UADMIN', text: 'not sure yet' },
        { ts: 'post.3', user: 'UADMIN', text: 'api' },
      ]);
    mockRunCodex.mockResolvedValueOnce({ ok: true, parsedJson: { intent: 'unclear' } });

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(2);
    expect((await promise).outcome).toBe('newton-api');
  });
});
