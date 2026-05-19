/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForClarification } from '../src/agents/pipeline.js';
import { fetchThreadContext } from '../src/slack/threadContext.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/slack/threadContext.js', () => ({
  fetchThreadContext: vi.fn(),
  assertThreadParentExists: vi.fn().mockResolvedValue(true),
}));

const mockFetchThread = fetchThreadContext as unknown as ReturnType<typeof vi.fn>;

function makeSlack() {
  return { chat: { postMessage: vi.fn() } } as any;
}

async function pump(n: number) {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(5_000);
  }
}

describe('waitForClarification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchThread.mockReset();
  });

  it('returns the first answer from an allowed user', async () => {
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UREQ', text: 'use the admin endpoint' }]);

    const promise = waitForClarification({
      slack: makeSlack(),
      channelId: 'C01',
      threadTs: '111.00',
      allowedUserIds: ['UREQ', 'UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await pump(1);
    const result = await promise;
    expect(result.answer).toBe('use the admin endpoint');
    expect(result.answererId).toBe('UREQ');
  });

  it('accepts an admin answer even when the original requester is not present', async () => {
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'the web one' }]);

    const promise = waitForClarification({
      slack: makeSlack(),
      channelId: 'C01',
      threadTs: '111.00',
      allowedUserIds: ['UREQ', 'UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await pump(1);
    expect((await promise).answererId).toBe('UADMIN');
  });

  it('ignores messages from users outside the allowed list', async () => {
    mockFetchThread
      .mockResolvedValueOnce([{ ts: 'post.2', user: 'UOTHER', text: 'my opinion' }])
      .mockResolvedValueOnce([
        { ts: 'post.2', user: 'UOTHER', text: 'my opinion' },
        { ts: 'post.3', user: 'UREQ', text: 'endpoint v2' },
      ]);

    const promise = waitForClarification({
      slack: makeSlack(),
      channelId: 'C01',
      threadTs: '111.00',
      allowedUserIds: ['UREQ'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await pump(2);
    expect((await promise).answer).toBe('endpoint v2');
  });

  it('skips empty messages and keeps waiting', async () => {
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UREQ', text: '   ' }]).mockResolvedValueOnce([
      { ts: 'post.2', user: 'UREQ', text: '   ' },
      { ts: 'post.3', user: 'UREQ', text: 'real answer' },
    ]);

    const promise = waitForClarification({
      slack: makeSlack(),
      channelId: 'C01',
      threadTs: '111.00',
      allowedUserIds: ['UREQ'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await pump(2);
    expect((await promise).answer).toBe('real answer');
  });
});
