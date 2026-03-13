import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentPipeline } from '../src/agents/pipeline.js';
import { runCodex } from '../src/codex/runCodex.js';
import type { AgentContext, PipelineConfig } from '../src/agents/types.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
}));

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
  workflowTimeouts: { prReviewMs: 720000, bugFixMs: 2700000 },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: true,
};

const task: NormalizedTask = {
  event: {
    eventId: 'EvPipeline1',
    channelId: 'C1',
    threadTs: '111.22',
    eventTs: '111.22',
    userId: 'U123',
    text: '<@UBOT1> review this PR',
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  intent: 'PR_REVIEW',
};

function makePipelineConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    agents: ['planner', 'reviewer'],
    maxRetryLoops: 2,
    perAgentTimeoutMs: 300000,
    totalTimeoutMs: 600000,
    abortOnCriticalFinding: true,
    slackProgressUpdates: false,
    ...overrides,
  };
}

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    workflowIntent: 'PR_REVIEW',
    task,
    config,
    repoPath: '/Users/dipesh/code/newton-web',
    threadContext: 'Test thread context',
    previousSteps: [],
    pipelineConfig: makePipelineConfig(),
    ...overrides,
  };
}

const slack = {
  chat: {
    postMessage: vi.fn().mockResolvedValue({ ok: true }),
  },
};

const logStep = vi.fn();

describe('agentPipeline', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    slack.chat.postMessage.mockClear();
    logStep.mockClear();
  });

  it('executes agents in sequence, passing context forward', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          plan: ['step 1'],
          risks: [],
          affectedFiles: ['file.ts'],
          scope: 'small',
          requiresCodeChanges: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          approved: true,
          findings: [],
          blockers: [],
        },
      });

    const result = await runAgentPipeline({
      ctx: makeContext(),
      slack: slack as any,
      logStep,
    });

    expect(result.finalStatus).toBe('passed');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].role).toBe('planner');
    expect(result.steps[1].role).toBe('reviewer');
    expect(runCodex).toHaveBeenCalledTimes(2);
  });

  it('triggers coder re-run when reviewer rejects (feedback loop)', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'coder', 'reviewer'],
        maxRetryLoops: 1,
      }),
    });

    vi.mocked(runCodex)
      // planner
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { plan: ['fix it'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: true },
      })
      // coder
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { filesChanged: ['a.ts'], summary: 'Fixed', testsAdded: [], branch: 'codex/fix' },
      })
      // reviewer (rejects)
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: {
          approved: false,
          findings: [{ severity: 'high', category: 'logic', message: 'Missing edge case' }],
          blockers: ['Missing edge case handling'],
        },
      })
      // coder retry
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { filesChanged: ['a.ts'], summary: 'Fixed with edge case', testsAdded: ['a.test.ts'], branch: 'codex/fix' },
      })
      // reviewer retry (approves)
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { approved: true, findings: [], blockers: [] },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(result.retryLoops).toBe(1);
    expect(result.finalStatus).toBe('passed');
    expect(runCodex).toHaveBeenCalledTimes(5);
  });

  it('respects maxRetryLoops (no infinite loops)', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'coder', 'reviewer'],
        maxRetryLoops: 1,
      }),
    });

    vi.mocked(runCodex)
      // planner
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { plan: ['fix it'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: true },
      })
      // coder
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { filesChanged: ['a.ts'], summary: 'Fixed', testsAdded: [], branch: 'codex/fix' },
      })
      // reviewer rejects
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { approved: false, findings: [{ severity: 'high', category: 'logic', message: 'Bad' }], blockers: ['Bad'] },
      })
      // coder retry
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { filesChanged: ['a.ts'], summary: 'Retry', testsAdded: [], branch: 'codex/fix' },
      })
      // reviewer rejects again (max loops exhausted)
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { approved: false, findings: [{ severity: 'high', category: 'logic', message: 'Still bad' }], blockers: ['Still bad'] },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(result.retryLoops).toBe(1);
    expect(result.finalStatus).toBe('failed');
  });

  it('aborts pipeline on critical security finding', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'security', 'reviewer'],
        abortOnCriticalFinding: true,
      }),
    });

    vi.mocked(runCodex)
      // planner
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { plan: ['review'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: false },
      })
      // security (critical finding)
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: {
          approved: false,
          findings: [{ severity: 'critical', category: 'xss', message: 'XSS vulnerability found' }],
          overallSeverity: 'critical',
        },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(result.finalStatus).toBe('aborted');
    expect(result.steps).toHaveLength(2);
    // reviewer should NOT have run
    expect(runCodex).toHaveBeenCalledTimes(2);
  });

  it('posts Slack progress updates at each step when enabled', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'reviewer'],
        slackProgressUpdates: true,
      }),
    });

    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { plan: ['test'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: false },
      })
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { approved: true, findings: [], blockers: [] },
      });

    await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('[1/2] planner:') }),
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('[2/2] reviewer:') }),
    );
  });

  it('aggregates findings from all agents', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { plan: ['test'], risks: ['risk1'], affectedFiles: [], scope: 'small', requiresCodeChanges: false },
      })
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: {
          approved: true,
          findings: [
            { severity: 'medium', category: 'style', message: 'Style issue' },
            { severity: 'low', category: 'naming', message: 'Naming convention' },
          ],
          blockers: [],
        },
      });

    const result = await runAgentPipeline({
      ctx: makeContext(),
      slack: slack as any,
      logStep,
    });

    expect(result.aggregatedFindings).toHaveLength(2);
    expect(result.aggregatedFindings[0].category).toBe('style');
    expect(result.aggregatedFindings[1].category).toBe('naming');
  });

  it('assigns appropriate model profiles per agent role', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { plan: ['test'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: false },
      })
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { approved: true, findings: [], blockers: [] },
      });

    await runAgentPipeline({
      ctx: makeContext(),
      slack: slack as any,
      logStep,
    });

    // Planner uses lightweight profile
    expect(runCodex).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'low' }),
    );
    // Reviewer uses high-reasoning profile
    expect(runCodex).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'xhigh' }),
    );
  });

  it('handles total timeout across multi-step pipeline', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'reviewer', 'security'],
        totalTimeoutMs: 50,
      }),
    });

    // First agent resolves but introduces a delay to trigger timeout before third agent
    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { plan: ['test'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: false },
      })
      .mockImplementationOnce(async () => {
        // Introduce a delay that exceeds the total timeout
        await new Promise(resolve => setTimeout(resolve, 100));
        return {
          ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
          parsedJson: { approved: true, findings: [], blockers: [] },
        };
      })
      .mockResolvedValueOnce({
        ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '',
        parsedJson: { approved: true, findings: [], overallSeverity: 'clean' },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    // Pipeline should detect timeout and abort before completing all steps
    expect(result.finalStatus).toBe('aborted');
    // Security agent should not have run
    expect(result.steps.length).toBeLessThan(3);
  });
});
