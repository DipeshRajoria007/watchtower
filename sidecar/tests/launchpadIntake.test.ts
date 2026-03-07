import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { runLaunchpadRequestPoller } from '../src/launchpad/launchpadIntake.js';
import { JobStore } from '../src/state/jobStore.js';
import type { AppConfig, SlackEventEnvelope } from '../src/types/contracts.js';

vi.mock('../src/notify/desktopNotifier.js', () => ({
  notifyDesktop: vi.fn(),
}));

const repoRoot = path.resolve(process.cwd(), '..');

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
    newtonWeb: repoRoot,
    newtonApi: repoRoot,
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
};

function createStore(): { dbPath: string; store: JobStore } {
  const dbPath = path.join(os.tmpdir(), `watchtower-launchpad-intake-${uuidv4()}.db`);
  return {
    dbPath,
    store: new JobStore(dbPath),
  };
}

describe('launchpadIntake', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('claims a pending request, creates a DM anchor, and enqueues a synthetic launchpad event', async () => {
    const { dbPath, store } = createStore();
    store.createLaunchpadRequest({
      id: 'req-1',
      target: 'miniog',
      prompt: 'Ship the feature',
      ownerUserId: 'UOWNER1',
    });

    const webClient = {
      conversations: {
        open: vi.fn().mockResolvedValue({
          ok: true,
          channel: {
            id: 'D123',
          },
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({
          ok: true,
          ts: '1711.42',
        }),
      },
    };

    const enqueue = vi.fn<
      (event: SlackEventEnvelope, client: typeof webClient, source: 'launchpad') => Promise<void>
    >()
      .mockResolvedValue(undefined);

    await runLaunchpadRequestPoller({
      webClient: webClient as any,
      config,
      store,
      enqueue,
    });

    const request = store.getLaunchpadRequest('req-1');
    expect(request?.status).toBe('QUEUED');
    expect(request?.slackChannelId).toBe('D123');
    expect(request?.anchorTs).toBe('1711.42');
    expect(webClient.conversations.open).toHaveBeenCalledWith({
      users: 'UOWNER1',
    });
    expect(webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'D123',
      text: 'Ship the feature',
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'D123',
        channelType: 'im',
        threadTs: '1711.42',
        eventTs: '1711.42',
        userId: 'UOWNER1',
        text: '<@UBOT1> Ship the feature',
        ingestSource: 'launchpad',
        launchpadRequestId: 'req-1',
      }),
      webClient,
      'launchpad',
    );

    store.close();
    fs.rmSync(dbPath, { force: true });
  });
});
