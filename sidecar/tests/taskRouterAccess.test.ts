import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toResolvedAccessControlConfig } from '../src/access/control.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

const runPrReviewWorkflow = vi.fn();
const runImplementationWorkflow = vi.fn();
const runDevAssistWorkflow = vi.fn();
const runDeployWorkflow = vi.fn();
const runInformationalWorkflow = vi.fn();
const runConversationalWorkflow = vi.fn();
const runUnknownTaskWorkflow = vi.fn();
const classifyWorkflowIntent = vi.fn();

vi.mock('../src/workflows/prReviewWorkflow.js', () => ({
  runPrReviewWorkflow,
}));

vi.mock('../src/workflows/implementationWorkflow.js', () => ({
  runImplementationWorkflow,
}));

vi.mock('../src/workflows/devAssistWorkflow.js', () => ({
  runDevAssistWorkflow,
}));

vi.mock('../src/workflows/deployWorkflow.js', () => ({
  runDeployWorkflow,
}));

vi.mock('../src/workflows/informationalWorkflow.js', () => ({
  runInformationalWorkflow,
}));

vi.mock('../src/workflows/conversationalWorkflow.js', () => ({
  runConversationalWorkflow,
}));

vi.mock('../src/workflows/unknownTaskWorkflow.js', () => ({
  runUnknownTaskWorkflow,
}));

vi.mock('../src/router/classifyIntent.js', () => ({
  classifyWorkflowIntent,
}));

vi.mock('../src/workflows/matcher.js', () => ({
  matchWorkflowTemplate: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../src/workflows/registry.js', () => ({
  getWorkflowTemplates: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/workflows/shared/workflowUtils.js', async () => {
  const actual = await vi.importActual('../src/workflows/shared/workflowUtils.js');
  return {
    ...actual,
    isPresencePing: vi.fn().mockReturnValue(false),
  };
});

const { routeTask } = await import('../src/router/taskRouter.js');

function makeConfig(mode: 'audit' | 'enforce'): AppConfig {
  return {
    platformPolicy: 'macos_only',
    bundleTargets: ['app', 'dmg'],
    ownerSlackUserIds: ['UOWNER1'],
    coreDevSlackUserIds: ['UOWNER1'],
    coreDevSlackUserGroup: '',
    botUserId: 'UBOT1',
    slackBotToken: 'xoxb-test',
    slackAppToken: 'xapp-test',
    bugsAndUpdatesChannelId: 'C-BUILD',
    allowedChannelsForBugFix: ['C-BUILD'],
    repoPaths: {
      newtonWeb: '/Users/dipesh/code/newton-web',
      newtonApi: '/Users/dipesh/code/newton-api',
    },
    unknownTaskPolicy: 'desktop_only',
    uncertainRepoPolicy: 'desktop_only',
    unmappedPrRepoPolicy: 'desktop_only',
    maxConcurrentJobs: 2,
    repoClassifierThreshold: 0.75,
    allowedPrOrg: 'Newton-School',
    multiAgentEnabled: false,
    agentBackend: 'codex',
    prReviewTimeoutMs: 120_000,
    bugFixTimeoutMs: 120_000,
    pmTaskTimeoutMs: 120_000,
    accessControl: toResolvedAccessControlConfig(
      {
        mode,
        groups: {
          viewer: {
            slackUserGroupHandle: '',
            manualUserIds: 'UVIEWER',
            allowedChannelIds: 'C-VIEW',
            allowIm: true,
            allowMpim: false,
          },
          reviewer: {
            slackUserGroupHandle: '',
            manualUserIds: 'UREVIEW',
            allowedChannelIds: 'C-REVIEW',
            allowIm: false,
            allowMpim: false,
          },
          builder: {
            slackUserGroupHandle: '',
            manualUserIds: 'UBUILDER',
            allowedChannelIds: 'C-BUILD',
            allowIm: false,
            allowMpim: false,
          },
          admin: {
            slackUserGroupHandle: '',
            manualUserIds: 'UADMIN',
            allowedChannelIds: 'C-ADMIN',
            allowIm: true,
            allowMpim: true,
          },
        },
      },
      ['UOWNER1'],
    ),
  };
}

function makeTask(
  input: Partial<NormalizedTask> & { userId: string; channelId: string; text: string },
): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: input.channelId,
      channelType: input.channelId.startsWith('D') ? 'im' : 'channel',
      threadTs: '111.22',
      eventTs: '111.22',
      userId: input.userId,
      text: input.text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: input.userId === 'UOWNER1',
    isCoreDevAuthor: input.userId === 'UOWNER1',
    intent: input.intent ?? 'OWNER_AUTOPILOT',
    prContext: input.prContext,
  };
}

function makeSlack() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  classifyWorkflowIntent.mockResolvedValue({
    intent: 'PR_REVIEW',
    confidence: 0.91,
    reasoning: 'review request',
  });
  runPrReviewWorkflow.mockResolvedValue({
    workflow: 'PR_REVIEW',
    status: 'SUCCESS',
    message: 'review ok',
    notifyDesktop: false,
    slackPosted: true,
  });
  runImplementationWorkflow.mockResolvedValue({
    workflow: 'IMPLEMENTATION',
    status: 'SUCCESS',
    message: 'impl ok',
    notifyDesktop: false,
    slackPosted: true,
  });
  runDevAssistWorkflow.mockResolvedValue({
    workflow: 'DEV_ASSIST',
    status: 'SUCCESS',
    message: 'dev assist ok',
    notifyDesktop: false,
    slackPosted: true,
  });
  runDeployWorkflow.mockResolvedValue({
    workflow: 'DEPLOY',
    status: 'SUCCESS',
    message: 'deploy ok',
    notifyDesktop: false,
    slackPosted: true,
  });
  runInformationalWorkflow.mockResolvedValue({
    workflow: 'INFORMATIONAL',
    status: 'SUCCESS',
    message: 'info ok',
    notifyDesktop: false,
    slackPosted: true,
  });
  runConversationalWorkflow.mockResolvedValue({
    workflow: 'CONVERSATIONAL',
    status: 'SUCCESS',
    message: 'chat ok',
    notifyDesktop: false,
    slackPosted: true,
  });
  runUnknownTaskWorkflow.mockResolvedValue({
    workflow: 'UNKNOWN',
    status: 'SKIPPED',
    message: 'unknown ok',
    notifyDesktop: false,
    slackPosted: true,
  });
});

describe('routeTask access control', () => {
  it('logs would-deny in audit mode but still runs the workflow', async () => {
    const config = makeConfig('audit');
    const slack = makeSlack();
    const logStep = vi.fn();

    const result = await routeTask({
      task: makeTask({
        userId: 'UVIEWER',
        channelId: 'C-VIEW',
        text: '<@UBOT1> please review this PR',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep,
    });

    expect(result.status).toBe('SUCCESS');
    expect(runPrReviewWorkflow).toHaveBeenCalledOnce();
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'access.audit.would_deny',
      }),
    );
  });

  it('blocks the workflow in enforce mode when access is missing', async () => {
    const config = makeConfig('enforce');
    const slack = makeSlack();

    const result = await routeTask({
      task: makeTask({
        userId: 'UVIEWER',
        channelId: 'C-VIEW',
        text: '<@UBOT1> please review this PR',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(result.status).toBe('SKIPPED');
    expect(runPrReviewWorkflow).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Access denied'),
      }),
    );
  });

  it('allows admins to use wt commands', async () => {
    const config = makeConfig('enforce');

    const result = await routeTask({
      task: makeTask({
        userId: 'UADMIN',
        channelId: 'D-ADMIN',
        text: '<@UBOT1> wt status',
        intent: 'DEV_ASSIST',
      }),
      config,
      slack: makeSlack() as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(result.status).toBe('SUCCESS');
    expect(runDevAssistWorkflow).toHaveBeenCalledOnce();
  });

  it('blocks builders from deploy and lets the owner bypass', async () => {
    const config = makeConfig('enforce');
    const slack = makeSlack();

    const blocked = await routeTask({
      task: makeTask({
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        text: '<@UBOT1> deploy prod',
        intent: 'DEPLOY',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(blocked.status).toBe('SKIPPED');
    expect(runDeployWorkflow).not.toHaveBeenCalled();

    const ownerResult = await routeTask({
      task: makeTask({
        userId: 'UOWNER1',
        channelId: 'C-UNLISTED',
        text: '<@UBOT1> deploy prod',
        intent: 'DEPLOY',
      }),
      config,
      slack: makeSlack() as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(ownerResult.status).toBe('SUCCESS');
    expect(runDeployWorkflow).toHaveBeenCalledOnce();
  });
});
