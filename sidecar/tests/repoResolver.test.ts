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
const { resolveRepoOrAsk, inferRepoFromAffectedFiles, repoPathFor } =
  await import('../src/workflows/shared/repoResolver.js');

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
    owner: emptyGroup('owner'),
  },
});

function emptyGroup<K extends 'viewer' | 'reviewer' | 'builder' | 'owner'>(key: K) {
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

  it('short-circuits to newton-web when planAffectedFiles all point inside a newton-web path', async () => {
    const res = await resolveRepoOrAsk({
      task: baseTask('do a thing'),
      config: baseConfig(),
      slack,
      threadMessages: [],
      planAffectedFiles: ['/repos/newton-web/src/foo.tsx'],
    });
    expect(res).toEqual(
      expect.objectContaining({ outcome: 'resolved', name: 'newton-web', source: 'plan-affected-files' }),
    );
    expect(classifyRepo).not.toHaveBeenCalled();
  });

  it('short-circuits to newton-api when planAffectedFiles all point inside a newton-api path', async () => {
    const res = await resolveRepoOrAsk({
      task: baseTask('do a thing'),
      config: baseConfig(),
      slack,
      threadMessages: [],
      planAffectedFiles: ['/repos/newton-api/handlers/foo.py'],
    });
    expect(res).toEqual(
      expect.objectContaining({ outcome: 'resolved', name: 'newton-api', source: 'plan-affected-files' }),
    );
    expect(classifyRepo).not.toHaveBeenCalled();
  });

  it('falls through to the agent when planAffectedFiles span both repos', async () => {
    vi.mocked(classifyRepo).mockResolvedValueOnce({
      selectedRepo: 'newton-web',
      confidence: 0.9,
      reasoning: 'web wins',
      uncertain: false,
    });
    const res = await resolveRepoOrAsk({
      task: baseTask('do a thing'),
      config: baseConfig(),
      slack,
      threadMessages: [],
      planAffectedFiles: ['/repos/newton-web/src/foo.tsx', '/repos/newton-api/handlers/bar.py'],
    });
    expect(res).toEqual(expect.objectContaining({ outcome: 'resolved', name: 'newton-web', source: 'classifier' }));
    expect(classifyRepo).toHaveBeenCalledTimes(1);
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

  it('passes task, thread, planAffectedFiles, and repoAffinity through to the classifier', async () => {
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
    expect(args.task).toBe('update handlers');
    expect(args.threadMessages).toEqual(['follow-up note']);
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

  it('inferRepoFromAffectedFiles returns the unambiguous repo or null', () => {
    expect(inferRepoFromAffectedFiles([])).toBeNull();
    expect(inferRepoFromAffectedFiles(['/repos/newton-web/src/a.tsx'])).toBe('newton-web');
    expect(inferRepoFromAffectedFiles(['handlers/x.py', '/repos/newton-api/y.py'])).toBe('newton-api');
    // mixed → null so we don't silently pick one
    expect(inferRepoFromAffectedFiles(['/repos/newton-web/src/a.tsx', '/repos/newton-api/handlers/b.py'])).toBeNull();
    // neither → null (no signal at all)
    expect(inferRepoFromAffectedFiles(['src/foo.ts', 'README.md'])).toBeNull();
  });

  it('inferRepoFromAffectedFiles ignores a single stray cross-repo reference', () => {
    // Regression for Slack thread p1779196094091969 (2026-05-19): the planner
    // for a newton-web feature listed ~25 repo-relative paths plus a single
    // context citation `newton-api/courses/enums.py:955-960`. The pre-fix
    // any-hit-wins logic routed the coder to newton-api with no code to edit.
    // After the fix, this case falls through to the AI classifier instead.
    const plannerOutput = [
      'src/containers/Nsat/components/RequestLoanFormNudge/index.js',
      'src/containers/Nsat/constants.js:600-604',
      'newton-api/courses/enums.py:955-960', // <-- the stray cross-reference
      'src/containers/Nsat/constants.js',
      'src/containers/NsatTimelineV2/constants.js',
      'src/containers/NsatTimelineV2/components/CampusVisitForm/index.js',
      'src/containers/NsatTimelineV2/components/CampusVisitForm/index.styles.js',
      'src/containers/NsatTimelineV2/timelineSteps/BlockFeePayment/index.js',
      'src/tracking/EVENTS/nsatTimelineV2.js',
      'src/utils/popupHandler.js',
    ];
    expect(inferRepoFromAffectedFiles(plannerOutput)).toBeNull();
  });

  it('inferRepoFromAffectedFiles still picks the clear-majority repo', () => {
    // When the planner DOES write fully-qualified paths, the deterministic
    // check should still fire — no extra round-trip to the classifier.
    const allWeb = [
      '/Users/dev/code/newton-web/src/a.tsx',
      '/Users/dev/code/newton-web/src/b.tsx',
      '/Users/dev/code/newton-web/src/c.tsx',
    ];
    expect(inferRepoFromAffectedFiles(allWeb)).toBe('newton-web');

    // Even with a single stray cross-reference, a strong majority still wins.
    expect(
      inferRepoFromAffectedFiles([
        '/repos/newton-web/src/a.tsx',
        '/repos/newton-web/src/b.tsx',
        '/repos/newton-web/src/c.tsx',
        '/repos/newton-web/src/d.tsx',
        'newton-api/courses/enums.py', // 1 out of 5 → not enough to flip
      ]),
    ).toBe('newton-web');
  });

  it('repoPathFor returns the configured path for the given repo', () => {
    const cfg = baseConfig();
    expect(repoPathFor('newton-web', cfg)).toBe('/repos/web');
    expect(repoPathFor('newton-api', cfg)).toBe('/repos/api');
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
