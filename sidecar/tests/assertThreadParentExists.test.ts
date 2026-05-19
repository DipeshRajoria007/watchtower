/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { assertThreadParentExists } from '../src/slack/threadContext.js';

function slackClientReturning(reply: unknown) {
  return {
    conversations: {
      replies: vi.fn().mockResolvedValue(reply),
    },
  } as any;
}

function slackClientThrowing(error: unknown) {
  return {
    conversations: {
      replies: vi.fn().mockRejectedValue(error),
    },
  } as any;
}

describe('assertThreadParentExists', () => {
  it('returns true when conversations.replies resolves normally', async () => {
    const client = slackClientReturning({ ok: true, messages: [{ ts: '1.0' }] });
    const exists = await assertThreadParentExists(client, 'C1', '1.0');
    expect(exists).toBe(true);
    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '1.0',
      inclusive: true,
      limit: 1,
    });
  });

  it('returns false when Slack errors with thread_not_found', async () => {
    const client = slackClientThrowing({ data: { error: 'thread_not_found' } });
    expect(await assertThreadParentExists(client, 'C1', 'deleted-ts')).toBe(false);
  });

  it('returns false when Slack errors with message_not_found', async () => {
    // Slack uses message_not_found in some endpoints when a thread root has been
    // deleted; treat it the same as thread_not_found for the cancellation gate.
    const client = slackClientThrowing({ data: { error: 'message_not_found' } });
    expect(await assertThreadParentExists(client, 'C1', 'deleted-ts')).toBe(false);
  });

  it('re-throws unexpected errors (rate limit, network, auth) instead of swallowing them', async () => {
    // We don't want a 429 or a 401 to silently look like "parent gone" — that
    // would skip work for the wrong reason. Let the workflow's outer
    // try-catch handle real failures.
    const client = slackClientThrowing({ data: { error: 'rate_limited' } });
    await expect(assertThreadParentExists(client, 'C1', '1.0')).rejects.toMatchObject({
      data: { error: 'rate_limited' },
    });
  });

  it('re-throws plain errors with no data envelope', async () => {
    const client = slackClientThrowing(new Error('socket hang up'));
    await expect(assertThreadParentExists(client, 'C1', '1.0')).rejects.toThrow('socket hang up');
  });
});
