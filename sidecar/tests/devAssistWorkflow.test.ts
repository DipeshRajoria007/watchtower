import { describe, expect, it, vi } from 'vitest';
import { runDevAssistWorkflow } from '../src/workflows/devAssistWorkflow.js';
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

describe('devAssistWorkflow', () => {
  it('posts help text for wt help', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist1',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt help',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      intent: 'DEV_ASSIST',
    };

    const result = await runDevAssistWorkflow({
      task,
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(slack.chat.postMessage).toHaveBeenCalled();
    expect(result.result?.command).toBe('HELP');
  });
});
