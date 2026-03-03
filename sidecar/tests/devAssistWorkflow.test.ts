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
      store: {
        getDevStatusSnapshot: () => ({
          activeJobs: 0,
          runs24h: 0,
          failures24h: 0,
          successRate24h: 100,
        }),
      } as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(slack.chat.postMessage).toHaveBeenCalled();
    expect(result.result?.command).toBe('HELP');
  });

  it('posts status snapshot for wt status', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist2',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt status',
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
      store: {
        getDevStatusSnapshot: () => ({
          activeJobs: 1,
          runs24h: 12,
          failures24h: 2,
          successRate24h: 83.3,
        }),
      } as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.result?.command).toBe('STATUS');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Watchtower status'),
      }),
    );
  });

  it('posts recent runs for wt runs', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist3',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt runs 2',
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
      store: {
        getDevStatusSnapshot: () => ({
          activeJobs: 1,
          runs24h: 12,
          failures24h: 2,
          successRate24h: 83.3,
        }),
        listDevRuns: () => [
          {
            id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            workflow: 'PR_REVIEW',
            status: 'SUCCESS',
            updatedAt: '2026-03-04T00:00:00.000Z',
          },
          {
            id: 'fffffff1-bbbb-cccc-dddd-eeeeeeeeeeee',
            workflow: 'BUG_FIX',
            status: 'FAILED',
            updatedAt: '2026-03-04T00:01:00.000Z',
          },
        ],
      } as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.result?.command).toBe('RUNS');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Recent runs:'),
      }),
    );
  });

  it('posts recent failures for wt failures', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist4',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt failures 2',
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
      store: {
        getDevStatusSnapshot: () => ({
          activeJobs: 1,
          runs24h: 12,
          failures24h: 2,
          successRate24h: 83.3,
        }),
        listDevRuns: (_limit: number, status?: string) =>
          status === 'FAILED'
            ? [
                {
                  id: 'fffffff1-bbbb-cccc-dddd-eeeeeeeeeeee',
                  workflow: 'BUG_FIX',
                  status: 'FAILED',
                  updatedAt: '2026-03-04T00:01:00.000Z',
                  errorMessage: 'timeout',
                },
              ]
            : [],
      } as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.result?.command).toBe('FAILURES');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Recent failures:'),
      }),
    );
  });

  it('posts trace lines for wt trace', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist5',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt trace abc123 2',
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
      store: {
        getDevStatusSnapshot: () => ({
          activeJobs: 1,
          runs24h: 12,
          failures24h: 2,
          successRate24h: 83.3,
        }),
        listDevRuns: () => [],
        resolveJobId: () => 'abc12345-1111-2222-3333-444444444444',
        listJobLogsTail: () => [
          {
            id: 10,
            jobId: 'abc12345-1111-2222-3333-444444444444',
            level: 'INFO',
            stage: 'job.attempt.start',
            message: 'Starting workflow attempt.',
            createdAt: '2026-03-04T00:00:00.000Z',
          },
          {
            id: 11,
            jobId: 'abc12345-1111-2222-3333-444444444444',
            level: 'ERROR',
            stage: 'codex.execution.error',
            message: 'Error: spawn codex ENOENT',
            createdAt: '2026-03-04T00:00:10.000Z',
          },
        ],
      } as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.result?.command).toBe('TRACE');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Trace for job'),
      }),
    );
  });
});
