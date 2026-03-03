import { describe, expect, it, vi } from 'vitest';
import { runUnknownTaskWorkflow } from '../src/workflows/unknownTaskWorkflow.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

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
    newtonWeb: '/Users/dipesh/code/newton-web',
    newtonApi: '/Users/dipesh/code/newton-api',
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

describe('unknownTaskWorkflow', () => {
  it('posts tagged dark-humor reply and adds reaction', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'EvUnknown1',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> do weird stuff',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      intent: 'UNKNOWN',
    };

    const result = await runUnknownTaskWorkflow({
      task,
      config,
      slack: slack as any,
      generateUnknownReply: async () => ({
        reply: "that's chaotic. bring a concrete bug or PR before i summon production ghosts.",
        reaction: 'skull',
      }),
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.slackPosted).toBe(true);
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('<@U777>'),
      }),
    );
    expect(slack.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'skull',
      }),
    );
  });
});
