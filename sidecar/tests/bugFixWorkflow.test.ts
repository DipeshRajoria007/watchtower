import { describe, expect, it, vi } from 'vitest';
import { runBugFixWorkflow } from '../src/workflows/bugFixWorkflow.js';
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

describe('bugFixWorkflow', () => {
  it('returns skipped when repo classification is uncertain', async () => {
    const slack = {
      conversations: {
        replies: vi.fn().mockResolvedValue({ messages: [{ text: 'UI and API both fail in different ways' }] }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'Ev1',
        channelId: 'C01H25RNLJH',
        threadTs: '123.45',
        eventTs: '123.45',
        userId: 'U123',
        text: '<@UBOT1> bug fix needed for frontend and backend',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      intent: 'BUG_FIX',
    };

    const result = await runBugFixWorkflow({
      task,
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('SKIPPED');
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });
});
