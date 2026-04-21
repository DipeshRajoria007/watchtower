/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRepoOrAsk } from '../src/workflows/shared/repoResolver.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

vi.mock('../src/agents/pipeline.js', () => ({
  waitForRepoChoice: vi.fn(),
}));

const { waitForRepoChoice } = await import('../src/agents/pipeline.js');

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

describe('resolveRepoOrAsk', () => {
  beforeEach(() => {
    vi.mocked(waitForRepoChoice).mockReset();
    slack.chat.postMessage.mockClear();
  });

  it('picks newton-web when planAffectedFiles point there', async () => {
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
  });

  it('picks newton-api from explicit text mention', async () => {
    const res = await resolveRepoOrAsk({
      task: baseTask('fix the rate limiter in newton-api'),
      config: baseConfig(),
      slack,
      threadMessages: [],
    });
    expect(res).toEqual(expect.objectContaining({ outcome: 'resolved', name: 'newton-api', source: 'text-mention' }));
  });

  it('uses extension hint when files are only .py or only .tsx', async () => {
    const web = await resolveRepoOrAsk({
      task: baseTask('update components'),
      config: baseConfig(),
      slack,
      threadMessages: [],
      planAffectedFiles: ['src/Button.tsx', 'src/Card.jsx'],
    });
    expect(web).toEqual(expect.objectContaining({ name: 'newton-web', source: 'extension-hint' }));

    const api = await resolveRepoOrAsk({
      task: baseTask('update handlers'),
      config: baseConfig(),
      slack,
      threadMessages: [],
      planAffectedFiles: ['handlers/create.py'],
    });
    expect(api).toEqual(expect.objectContaining({ name: 'newton-api', source: 'extension-hint' }));
  });

  it('returns desktop_only when classifier uncertain and no admin reply', async () => {
    vi.mocked(waitForRepoChoice).mockResolvedValueOnce({ outcome: 'timeout', userReply: '', approverId: '' });
    const config = baseConfig();
    config.accessControl = {
      mode: 'enforce',
      groups: {
        viewer: {
          key: 'viewer',
          slackUserGroupHandle: '',
          manualUserIds: '',
          allowedChannelIds: '',
          allowIm: false,
          allowMpim: false,
          resolvedChannelIds: [],
          resolvedUserIds: [],
        },
        reviewer: {
          key: 'reviewer',
          slackUserGroupHandle: '',
          manualUserIds: '',
          allowedChannelIds: '',
          allowIm: false,
          allowMpim: false,
          resolvedChannelIds: [],
          resolvedUserIds: [],
        },
        builder: {
          key: 'builder',
          slackUserGroupHandle: '',
          manualUserIds: '',
          allowedChannelIds: '',
          allowIm: false,
          allowMpim: false,
          resolvedChannelIds: [],
          resolvedUserIds: [],
        },
        admin: {
          key: 'admin',
          slackUserGroupHandle: '',
          manualUserIds: 'UADMIN',
          allowedChannelIds: '',
          allowIm: false,
          allowMpim: false,
          resolvedChannelIds: [],
          resolvedUserIds: ['UADMIN'],
        },
      },
    };

    const res = await resolveRepoOrAsk({
      task: baseTask('something is off, please look'),
      config,
      slack,
      threadMessages: [{ text: 'yeah weird' }],
    });
    expect(res.outcome).toBe('desktop_only');
  });

  it('returns desktop_only immediately when askAdminsOnUncertain is false', async () => {
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
    vi.mocked(waitForRepoChoice).mockResolvedValueOnce({
      outcome: 'cancelled',
      userReply: 'cancel',
      approverId: 'UADMIN',
    });
    const config = baseConfig();
    config.accessControl = {
      mode: 'enforce',
      groups: {
        viewer: {
          key: 'viewer',
          slackUserGroupHandle: '',
          manualUserIds: '',
          allowedChannelIds: '',
          allowIm: false,
          allowMpim: false,
          resolvedChannelIds: [],
          resolvedUserIds: [],
        },
        reviewer: {
          key: 'reviewer',
          slackUserGroupHandle: '',
          manualUserIds: '',
          allowedChannelIds: '',
          allowIm: false,
          allowMpim: false,
          resolvedChannelIds: [],
          resolvedUserIds: [],
        },
        builder: {
          key: 'builder',
          slackUserGroupHandle: '',
          manualUserIds: '',
          allowedChannelIds: '',
          allowIm: false,
          allowMpim: false,
          resolvedChannelIds: [],
          resolvedUserIds: [],
        },
        admin: {
          key: 'admin',
          slackUserGroupHandle: '',
          manualUserIds: 'UADMIN',
          allowedChannelIds: '',
          allowIm: false,
          allowMpim: false,
          resolvedChannelIds: [],
          resolvedUserIds: ['UADMIN'],
        },
      },
    };
    const res = await resolveRepoOrAsk({
      task: baseTask('do a thing'),
      config,
      slack,
      threadMessages: [],
    });
    expect(res.outcome).toBe('cancelled');
  });
});
