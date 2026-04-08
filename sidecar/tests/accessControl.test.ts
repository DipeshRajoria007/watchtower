import { describe, expect, it } from 'vitest';
import {
  buildLegacyAccessControlConfig,
  evaluateAccess,
  resolveRequiredAccessLevel,
  setResolvedGroupMembers,
  toResolvedAccessControlConfig,
} from '../src/access/control.js';
import type { AppConfig } from '../src/types/contracts.js';

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
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
        mode: 'enforce',
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
    ...overrides,
  };
}

describe('access control evaluator', () => {
  it('maps workflow intents to the correct required level', () => {
    expect(resolveRequiredAccessLevel('CONVERSATIONAL')).toBe('viewer');
    expect(resolveRequiredAccessLevel('PR_REVIEW')).toBe('reviewer');
    expect(resolveRequiredAccessLevel('IMPLEMENTATION')).toBe('builder');
    expect(resolveRequiredAccessLevel('DEPLOY')).toBe('admin');
    expect(resolveRequiredAccessLevel('DEV_ASSIST')).toBe('admin');
  });

  it('allows viewers only in configured channels and DMs', () => {
    const config = makeConfig();
    expect(
      evaluateAccess({
        config,
        userId: 'UVIEWER',
        channelId: 'C-VIEW',
        requiredLevel: 'viewer',
      }).allowed,
    ).toBe(true);

    expect(
      evaluateAccess({
        config,
        userId: 'UVIEWER',
        channelId: 'D123',
        channelType: 'im',
        requiredLevel: 'viewer',
      }).allowed,
    ).toBe(true);

    expect(
      evaluateAccess({
        config,
        userId: 'UVIEWER',
        channelId: 'C-VIEW',
        requiredLevel: 'builder',
      }).allowed,
    ).toBe(false);
  });

  it('allows reviewers to review but not build or deploy', () => {
    const config = makeConfig();
    expect(
      evaluateAccess({
        config,
        userId: 'UREVIEW',
        channelId: 'C-REVIEW',
        requiredLevel: 'reviewer',
      }).allowed,
    ).toBe(true);

    expect(
      evaluateAccess({
        config,
        userId: 'UREVIEW',
        channelId: 'C-REVIEW',
        requiredLevel: 'builder',
      }).allowed,
    ).toBe(false);

    expect(
      evaluateAccess({
        config,
        userId: 'UREVIEW',
        channelId: 'C-REVIEW',
        requiredLevel: 'admin',
      }).allowed,
    ).toBe(false);
  });

  it('allows builders to implement but not deploy', () => {
    const config = makeConfig();
    expect(
      evaluateAccess({
        config,
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        requiredLevel: 'builder',
      }).allowed,
    ).toBe(true);

    expect(
      evaluateAccess({
        config,
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        requiredLevel: 'admin',
      }).allowed,
    ).toBe(false);
  });

  it('allows admins to deploy and use wt commands in channels and DMs', () => {
    const config = makeConfig();
    expect(
      evaluateAccess({
        config,
        userId: 'UADMIN',
        channelId: 'C-ADMIN',
        requiredLevel: 'admin',
      }).allowed,
    ).toBe(true);

    expect(
      evaluateAccess({
        config,
        userId: 'UADMIN',
        channelId: 'D123',
        channelType: 'im',
        requiredLevel: 'admin',
      }).allowed,
    ).toBe(true);
  });

  it('always allows the owner regardless of group membership or channel rules', () => {
    const config = makeConfig();
    const decision = evaluateAccess({
      config,
      userId: 'UOWNER1',
      channelId: 'C-UNLISTED',
      requiredLevel: 'admin',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.ownerBypass).toBe(true);
  });

  it('pre-resolves channel IDs and merges refreshed members with manual and owner overrides', () => {
    const config = makeConfig();

    expect(config.accessControl?.groups.builder.resolvedChannelIds).toEqual(['C-BUILD']);

    setResolvedGroupMembers({
      config,
      groupKey: 'reviewer',
      members: ['UREVIEW2'],
    });
    expect(config.accessControl?.groups.reviewer.resolvedUserIds).toEqual(['UREVIEW', 'UREVIEW2']);

    setResolvedGroupMembers({
      config,
      groupKey: 'admin',
      members: ['UADMIN2', 'UOWNER1'],
    });
    expect(config.accessControl?.groups.admin.resolvedUserIds).toEqual(['UOWNER1', 'UADMIN', 'UADMIN2']);
  });

  it('seeds legacy builder and admin permissions from previous config', () => {
    const accessControl = buildLegacyAccessControlConfig({
      ownerSlackUserIds: ['UOWNER1'],
      coreDevSlackUserIds: ['UCOREDEV1'],
      coreDevSlackUserGroup: 'core-dev',
      allowedChannelsForBugFix: ['C-BUGS', 'C-OPS'],
    });

    expect(accessControl.mode).toBe('audit');
    expect(accessControl.groups.builder.allowedChannelIds).toBe('C-BUGS,C-OPS');
    expect(accessControl.groups.builder.resolvedChannelIds).toEqual(['C-BUGS', 'C-OPS']);
    expect(accessControl.groups.admin.allowedChannelIds).toBe('C-BUGS,C-OPS');
    expect(accessControl.groups.admin.allowIm).toBe(true);
    expect(accessControl.groups.admin.resolvedUserIds).toEqual(['UOWNER1', 'UCOREDEV1']);
  });
});
