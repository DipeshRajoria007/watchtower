import { describe, expect, it, vi } from 'vitest';
import { runPrReviewWorkflow } from '../src/workflows/prReviewWorkflow.js';
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
  githubOwnerTokenEnv: 'GITHUB_TOKEN',
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

describe('prReviewWorkflow', () => {
  it('asks for PR URL and pauses when PR context is missing', async () => {
    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({ messages: [{ text: 'please review this' }] }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev1',
        channelId: 'C1',
        threadTs: '123.45',
        eventTs: '123.45',
        userId: 'U123',
        text: '<@UBOT1> please review',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      intent: 'PR_REVIEW',
    };

    const result = await runPrReviewWorkflow({
      task,
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('PAUSED');
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });
});
