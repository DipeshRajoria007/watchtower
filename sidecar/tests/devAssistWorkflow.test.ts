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

  it('posts diagnosis for wt diagnose', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist6',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt diagnose abc123',
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
        getJobSummary: () => ({
          id: 'abc12345-1111-2222-3333-444444444444',
          workflow: 'OWNER_AUTOPILOT',
          status: 'FAILED',
          errorMessage: 'Error: spawn codex ENOENT',
        }),
        listJobLogsTail: () => [
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
    expect(result.result?.command).toBe('DIAGNOSE');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Failure diagnosis for'),
      }),
    );
  });

  it('posts learning snapshot for wt learn', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist7',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt learn',
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
        getDevLearningSnapshot: () => ({
          signals24h: 14,
          correctionsLearned: 4,
          correctionsApplied24h: 3,
          personalityProfiles: 2,
          topErrorKind: 'CODEX_BIN_NOT_FOUND',
        }),
        listDevRuns: () => [],
        resolveJobId: () => undefined,
        getJobSummary: () => undefined,
        listJobLogsTail: () => [],
      } as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.result?.command).toBe('LEARN');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Learning engine snapshot'),
      }),
    );
  });

  it('posts channel heat for wt heat', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist8',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt heat 2',
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
        getDevLearningSnapshot: () => ({
          signals24h: 14,
          correctionsLearned: 4,
          correctionsApplied24h: 3,
          personalityProfiles: 2,
          topErrorKind: 'CODEX_BIN_NOT_FOUND',
        }),
        getDevChannelHeat: () => [
          { channelId: 'C1', runs: 20, failures: 3 },
          { channelId: 'C2', runs: 11, failures: 1 },
        ],
        listDevRuns: () => [],
        resolveJobId: () => undefined,
        getJobSummary: () => undefined,
        listJobLogsTail: () => [],
      } as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.result?.command).toBe('HEAT');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Channel heat'),
      }),
    );
  });

  it('updates personality profile for wt personality set', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };
    const setPersonalityProfile = vi.fn();

    const task: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist9',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt personality set professional me',
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
        getDevLearningSnapshot: () => ({
          signals24h: 14,
          correctionsLearned: 4,
          correctionsApplied24h: 3,
          personalityProfiles: 2,
          topErrorKind: 'CODEX_BIN_NOT_FOUND',
        }),
        getDevChannelHeat: () => [],
        setPersonalityProfile,
        listDevRuns: () => [],
        resolveJobId: () => undefined,
        getJobSummary: () => undefined,
        listJobLogsTail: () => [],
      } as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.result?.command).toBe('PERSONALITY_SET');
    expect(setPersonalityProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'user',
        mode: 'professional',
      }),
    );
  });

  it('shows personality profile for wt personality show', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const task: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist10',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt personality show',
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
        getDevLearningSnapshot: () => ({
          signals24h: 14,
          correctionsLearned: 4,
          correctionsApplied24h: 3,
          personalityProfiles: 2,
          topErrorKind: 'CODEX_BIN_NOT_FOUND',
        }),
        getDevChannelHeat: () => [],
        setPersonalityProfile: () => {},
        getPersonalityProfile: () => 'friendly',
        getPersonalityMode: () => 'friendly',
        listDevRuns: () => [],
        resolveJobId: () => undefined,
        getJobSummary: () => undefined,
        listJobLogsTail: () => [],
      } as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.result?.command).toBe('PERSONALITY_SHOW');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Current personality'),
      }),
    );
  });

  it('starts and shows mission thread state', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };

    const startTask: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist11',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt mission start reduce flaky ci retries',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      intent: 'DEV_ASSIST',
    };

    const store = {
      getDevStatusSnapshot: () => ({
        activeJobs: 1,
        runs24h: 12,
        failures24h: 2,
        successRate24h: 83.3,
      }),
      getDevLearningSnapshot: () => ({
        signals24h: 14,
        correctionsLearned: 4,
        correctionsApplied24h: 3,
        personalityProfiles: 2,
        topErrorKind: 'CODEX_BIN_NOT_FOUND',
      }),
      getDevChannelHeat: () => [],
      setPersonalityProfile: () => {},
      getPersonalityProfile: () => undefined,
      getPersonalityMode: () => 'dark_humor',
      listDevRuns: () => [],
      resolveJobId: () => undefined,
      getJobSummary: () => undefined,
      listJobLogsTail: () => [],
      upsertMissionStart: () => ({ id: 'mission:C1:111.22', status: 'ACTIVE' }),
      getMissionThread: () => ({
        id: 'mission:C1:111.22',
        goal: 'reduce flaky ci retries',
        status: 'ACTIVE',
        progress: 'Not started',
        blockers: 'None',
        eta: 'TBD',
        ownerUserId: 'U777',
        updatedAt: '2026-03-04T00:00:00.000Z',
        plan: 'Plan pending',
      }),
      startMissionSwarmRun: () => ({
        runId: 'swarm:1',
        missionId: 'mission:C1:111.22',
        roles: ['planner', 'coder', 'reviewer', 'shipper'],
      }),
      setTrustPolicy: () => {},
    } as any;

    const startResult = await runDevAssistWorkflow({
      task: startTask,
      config,
      slack: slack as any,
      store,
    });

    expect(startResult.status).toBe('SUCCESS');
    expect(startResult.result?.command).toBe('MISSION_START');

    const showTask: NormalizedTask = {
      ...startTask,
      event: {
        ...startTask.event,
        eventId: 'EvDevAssist12',
        text: '<@UBOT1> wt mission show',
      },
    };

    const showResult = await runDevAssistWorkflow({
      task: showTask,
      config,
      slack: slack as any,
      store,
    });

    expect(showResult.status).toBe('SUCCESS');
    expect(showResult.result?.command).toBe('MISSION_SHOW');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Mission state for this thread'),
      }),
    );

    const swarmTask: NormalizedTask = {
      ...startTask,
      event: {
        ...startTask.event,
        eventId: 'EvDevAssist13',
        text: '<@UBOT1> wt mission run --swarm',
      },
    };

    const swarmResult = await runDevAssistWorkflow({
      task: swarmTask,
      config,
      slack: slack as any,
      store,
    });

    expect(swarmResult.status).toBe('SUCCESS');
    expect(swarmResult.result?.command).toBe('MISSION_RUN_SWARM');
  });

  it('updates trust policy via wt trust', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };
    const setTrustPolicy = vi.fn();

    const task: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist14',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt trust channel execute',
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
        getDevLearningSnapshot: () => ({
          signals24h: 14,
          correctionsLearned: 4,
          correctionsApplied24h: 3,
          personalityProfiles: 2,
          topErrorKind: 'CODEX_BIN_NOT_FOUND',
        }),
        getDevChannelHeat: () => [],
        setPersonalityProfile: () => {},
        getPersonalityProfile: () => 'friendly',
        getPersonalityMode: () => 'friendly',
        listDevRuns: () => [],
        resolveJobId: () => undefined,
        getJobSummary: () => undefined,
        listJobLogsTail: () => [],
        upsertMissionStart: () => ({ id: 'mission:C1:111.22', status: 'ACTIVE' }),
        getMissionThread: () => undefined,
        startMissionSwarmRun: () => undefined,
        setTrustPolicy,
        createReplayRequest: () => ({ requestId: 'replay:1', status: 'QUEUED' }),
      } as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.result?.command).toBe('TRUST_SET');
    expect(setTrustPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'channel',
        trustLevel: 'execute',
      }),
    );
  });

  it('queues replay/fork via wt replay and wt fork', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };
    const createReplayRequest = vi.fn().mockReturnValue({ requestId: 'replay:1', status: 'QUEUED' });

    const baseTask: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist15',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt replay job-1234',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      intent: 'DEV_ASSIST',
    };

    const store = {
      getDevStatusSnapshot: () => ({
        activeJobs: 1,
        runs24h: 12,
        failures24h: 2,
        successRate24h: 83.3,
      }),
      getDevLearningSnapshot: () => ({
        signals24h: 14,
        correctionsLearned: 4,
        correctionsApplied24h: 3,
        personalityProfiles: 2,
        topErrorKind: 'CODEX_BIN_NOT_FOUND',
      }),
      getDevChannelHeat: () => [],
      setPersonalityProfile: () => {},
      getPersonalityProfile: () => 'friendly',
      getPersonalityMode: () => 'friendly',
      listDevRuns: () => [],
      resolveJobId: () => 'job-1-uuid',
      getJobSummary: () => undefined,
      listJobLogsTail: () => [],
      upsertMissionStart: () => ({ id: 'mission:C1:111.22', status: 'ACTIVE' }),
      getMissionThread: () => undefined,
      startMissionSwarmRun: () => undefined,
      setTrustPolicy: () => {},
      createReplayRequest,
    } as any;

    const replayResult = await runDevAssistWorkflow({
      task: baseTask,
      config,
      slack: slack as any,
      store,
    });
    expect(replayResult.status).toBe('SUCCESS');
    expect(replayResult.result?.command).toBe('REPLAY');

    const forkResult = await runDevAssistWorkflow({
      task: {
        ...baseTask,
        event: {
          ...baseTask.event,
          eventId: 'EvDevAssist16',
          text: '<@UBOT1> wt fork job-1234',
        },
      },
      config,
      slack: slack as any,
      store,
    });
    expect(forkResult.status).toBe('SUCCESS');
    expect(forkResult.result?.command).toBe('FORK');
    expect(createReplayRequest).toHaveBeenCalled();
  });

  it('activates installed skill via wt skill use', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
    };
    const setChannelSkill = vi.fn();

    const task: NormalizedTask = {
      event: {
        eventId: 'EvDevAssist17',
        channelId: 'C1',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'U777',
        text: '<@UBOT1> wt skill use frontend-pr-review',
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
        getDevLearningSnapshot: () => ({
          signals24h: 14,
          correctionsLearned: 4,
          correctionsApplied24h: 3,
          personalityProfiles: 2,
          topErrorKind: 'CODEX_BIN_NOT_FOUND',
        }),
        getDevChannelHeat: () => [],
        setPersonalityProfile: () => {},
        getPersonalityProfile: () => 'friendly',
        getPersonalityMode: () => 'friendly',
        listDevRuns: () => [],
        resolveJobId: () => undefined,
        getJobSummary: () => undefined,
        listJobLogsTail: () => [],
        upsertMissionStart: () => ({ id: 'mission:C1:111.22', status: 'ACTIVE' }),
        getMissionThread: () => undefined,
        startMissionSwarmRun: () => undefined,
        setTrustPolicy: () => {},
        createReplayRequest: () => ({ requestId: 'replay:1', status: 'QUEUED' }),
        getSkill: () => ({
          name: 'frontend-pr-review',
          path: '/tmp/fake',
          version: 'v1',
        }),
        setChannelSkill,
      } as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.result?.command).toBe('SKILL_USE');
    expect(setChannelSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'C1',
        skillName: 'frontend-pr-review',
      }),
    );
  });
});
