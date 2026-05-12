/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

vi.mock('../src/agents/pipeline.js', () => ({
  waitForRepoChoice: vi.fn(),
}));
vi.mock('../src/router/repoClassifier.js', () => ({
  classifyRepo: vi.fn(),
}));

const { waitForRepoChoice } = await import('../src/agents/pipeline.js');
const { classifyRepo } = await import('../src/router/repoClassifier.js');
const { resolveRepoOrAsk } = await import('../src/workflows/shared/repoResolver.js');

const baseConfig = (): AppConfig => ({
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER'],
  coreDevSlackUserIds: ['UOWNER'],
  coreDevSlackUserGroup: '',
  botUserId: 'UBOT',
  slackBotToken: 'x',
  slackAppToken: 'x',
  bugsAndUpdatesChannelId: 'C1',
  allowedChannelsForBugFix: ['C1'],
  repoPaths: { newtonWeb: '/repos/web', newtonApi: '/repos/api' },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'org',
  multiAgentEnabled: true,
});

const baseTask = (text: string): NormalizedTask => ({
  event: {
    eventId: 'E1',
    channelId: 'C1',
    threadTs: '1.1',
    eventTs: '1.1',
    userId: 'U1',
    text,
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  isCoreDevAuthor: false,
  intent: 'IMPLEMENTATION',
});

const slack: any = { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '2.2' }) } };

const adminAccessControl = () => ({
  mode: 'enforce' as const,
  groups: {
    viewer: emptyGroup('viewer'),
    reviewer: emptyGroup('reviewer'),
    builder: emptyGroup('builder'),
    admin: {
      key: 'admin' as const,
      slackUserGroupHandle: '',
      manualUserIds: 'UADMIN',
      allowedChannelIds: '',
      allowIm: false,
      allowMpim: false,
      resolvedChannelIds: [],
      resolvedUserIds: ['UADMIN'],
    },
  },
});

function emptyGroup<K extends 'viewer' | 'reviewer' | 'builder'>(key: K) {
  return {
    key,
    slackUserGroupHandle: '',
    manualUserIds: '',
    allowedChannelIds: '',
    allowIm: false,
    allowMpim: false,
    resolvedChannelIds: [],
    resolvedUserIds: [],
  };
}

describe('resolveRepoOrAsk', () => {
  beforeEach(() => {
    vi.mocked(waitForRepoChoice).mockReset();
    vi.mocked(classifyRepo).mockReset();
    slack.chat.postMessage.mockClear();
  });

  it('resolves via the agent classifier when confident', async () => {
    vi.mocked(classifyRepo).mockResolvedValueOnce({
      selectedRepo: 'newton-web',
      confidence: 0.92,
      reasoning: 'nav bar change on a public URL',
      uncertain: false,
    });
    const res = await resolveRepoOrAsk({
      task: baseTask('remove the right nav bar section on my.newtonschool.co/tech-openings/all-jobs'),
      config: baseConfig(),
      slack,
      threadMessages: [],
    });
    expect(res).toEqual(expect.objectContaining({ outcome: 'resolved', name: 'newton-web', source: 'classifier' }));
  });

  it('passes planAffectedFiles and repoAffinity through to the classifier', async () => {
    vi.mocked(classifyRepo).mockResolvedValueOnce({
      selectedRepo: 'newton-api',
      confidence: 0.88,
      reasoning: 'planner pointed at .py files',
      uncertain: false,
    });
    await resolveRepoOrAsk({
      task: baseTask('update handlers'),
      config: baseConfig(),
      slack,
      threadMessages: [{ text: 'follow-up note' }],
      planAffectedFiles: ['handlers/create.py'],
      repoAffinity: { newtonApiHits: 12 },
    });
    const args = vi.mocked(classifyRepo).mock.calls[0][0];
    expect(args.planAffectedFiles).toEqual(['handlers/create.py']);
    expect(args.affinity).toEqual({ newtonApiHits: 12 });
    expect(args.texts).toEqual(['update handlers', 'follow-up note']);
    expect(args.threshold).toBe(0.75);
  });

  it('routes to the admin gate when the classifier is uncertain', async () => {
    vi.mocked(classifyRepo).mockResolvedValueOnce({
      selectedRepo: null,
      confidence: 0,
      reasoning: 'no signal',
      uncertain: true,
    });
    vi.mocked(waitForRepoChoice).mockResolvedValueOnce({
      outcome: 'newton-web',
      userReply: 'web',
      approverId: 'UADMIN',
    });
    const config = baseConfig();
    config.accessControl = adminAccessControl();
    const res = await resolveRepoOrAsk({
      task: baseTask('do the thing'),
      config,
      slack,
      threadMessages: [],
    });
    expect(res).toEqual(expect.objectContaining({ outcome: 'resolved', name: 'newton-web', source: 'admin-choice' }));
    expect(slack.chat.postMessage).toHaveBeenCalled();
  });

  it('returns desktop_only when classifier uncertain and no admin reply', async () => {
    vi.mocked(classifyRepo).mockResolvedValueOnce({
      selectedRepo: null,
      confidence: 0,
      reasoning: 'no signal',
      uncertain: true,
    });
    vi.mocked(waitForRepoChoice).mockResolvedValueOnce({ outcome: 'timeout', userReply: '', approverId: '' });
    const config = baseConfig();
    config.accessControl = adminAccessControl();
    const res = await resolveRepoOrAsk({
      task: baseTask('something is off, please look'),
      config,
      slack,
      threadMessages: [{ text: 'yeah weird' }],
    });
    expect(res.outcome).toBe('desktop_only');
  });

  it('returns desktop_only immediately when askAdminsOnUncertain is false', async () => {
    vi.mocked(classifyRepo).mockResolvedValueOnce({
      selectedRepo: null,
      confidence: 0,
      reasoning: 'no signal',
      uncertain: true,
    });
    const res = await resolveRepoOrAsk({
      task: baseTask('fix stuff'),
      config: baseConfig(),
      slack,
      threadMessages: [],
      askAdminsOnUncertain: false,
    });
    expect(res.outcome).toBe('desktop_only');
    expect(waitForRepoChoice).not.toHaveBeenCalled();
  });

  it('returns cancelled when admin replies cancel', async () => {
    vi.mocked(classifyRepo).mockResolvedValueOnce({
      selectedRepo: null,
      confidence: 0,
      reasoning: 'no signal',
      uncertain: true,
    });
    vi.mocked(waitForRepoChoice).mockResolvedValueOnce({
      outcome: 'cancelled',
      userReply: 'cancel',
      approverId: 'UADMIN',
    });
    const config = baseConfig();
    config.accessControl = adminAccessControl();
    const res = await resolveRepoOrAsk({
      task: baseTask('do a thing'),
      config,
      slack,
      threadMessages: [],
    });
    expect(res.outcome).toBe('cancelled');
  });
});
