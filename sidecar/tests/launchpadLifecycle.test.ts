import { describe, expect, it, vi } from 'vitest';
import { finalizeLaunchpadWorkflowResult } from '../src/launchpad/launchpadLifecycle.js';
import { notifyDesktop } from '../src/notify/desktopNotifier.js';

vi.mock('../src/notify/desktopNotifier.js', () => ({
  notifyDesktop: vi.fn(),
}));

describe('launchpadLifecycle', () => {
  it('posts a fallback completion reply and emits a success notification for launchpad runs', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '222.33' }),
      },
    };

    const store = {
      markLaunchpadRequestRunning: vi.fn(),
      markLaunchpadRequestFinished: vi.fn(),
    };

    await finalizeLaunchpadWorkflowResult({
      event: {
        eventId: 'launchpad:req-1:111.22',
        channelId: 'D123',
        channelType: 'im',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'UOWNER1',
        text: '<@UBOT1> Ship the feature',
        ingestSource: 'launchpad',
        launchpadRequestId: 'req-1',
        rawEvent: {},
      },
      result: {
        workflow: 'OWNER_AUTOPILOT',
        status: 'SUCCESS',
        message: 'Feature shipped.',
        notifyDesktop: false,
        slackPosted: false,
        result: {
          status: 'success',
        },
      },
      slack: slack as any,
      store,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: 'D123',
      thread_ts: '111.22',
      text: 'Feature shipped.',
    });
    expect(store.markLaunchpadRequestFinished).toHaveBeenCalledWith({
      id: 'req-1',
      status: 'SUCCESS',
      result: {
        status: 'success',
      },
      errorMessage: undefined,
    });
    expect(vi.mocked(notifyDesktop)).toHaveBeenCalledWith(
      'Watchtower miniOG complete',
      'Feature shipped.',
    );
  });
});
