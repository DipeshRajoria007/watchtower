import type {
  AccessControlConfig,
  AccessControlSettings,
  AccessGroupKey,
  AccessGroupSettings,
  AccessLevel,
  AppConfig,
  WorkflowIntent,
} from '../types/contracts.js';

export const ACCESS_GROUP_KEYS: AccessGroupKey[] = ['viewer', 'reviewer', 'builder', 'admin'];

const ACCESS_RANK: Record<AccessLevel, number> = {
  viewer: 0,
  reviewer: 1,
  builder: 2,
  admin: 3,
};

export type AccessDecision = {
  allowed: boolean;
  ownerBypass: boolean;
  requiredLevel: AccessLevel;
  matchedGroups: AccessGroupKey[];
  userGroups: AccessGroupKey[];
  reason?: string;
};

export function createDefaultAccessGroupSettings(): AccessGroupSettings {
  return {
    slackUserGroupHandle: '',
    manualUserIds: '',
    allowedChannelIds: '',
    allowIm: false,
    allowMpim: false,
  };
}

export function createDefaultAccessControlSettings(): AccessControlSettings {
  return {
    mode: 'audit',
    groups: {
      viewer: createDefaultAccessGroupSettings(),
      reviewer: createDefaultAccessGroupSettings(),
      builder: createDefaultAccessGroupSettings(),
      admin: createDefaultAccessGroupSettings(),
    },
  };
}

function uniqueList(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function parseDelimitedIds(raw: string): string[] {
  return uniqueList(
    raw
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  );
}

function hydrateAccessControlSettings(settings?: Partial<AccessControlSettings> | null): AccessControlSettings {
  const defaults = createDefaultAccessControlSettings();
  const groups = defaults.groups;

  for (const key of ACCESS_GROUP_KEYS) {
    groups[key] = {
      ...defaults.groups[key],
      ...(settings?.groups?.[key] ?? {}),
    };
  }

  return {
    mode: settings?.mode === 'enforce' ? 'enforce' : 'audit',
    groups,
  };
}

export function buildLegacyAccessControlConfig(input: {
  ownerSlackUserIds: string[];
  coreDevSlackUserIds?: string[];
  coreDevSlackUserGroup?: string;
  allowedChannelsForBugFix?: string[];
}): AccessControlConfig {
  const defaults = hydrateAccessControlSettings();
  const bugFixChannels = uniqueList(input.allowedChannelsForBugFix ?? []);
  defaults.groups.builder.allowedChannelIds = bugFixChannels.join(',');
  defaults.groups.admin.allowedChannelIds = bugFixChannels.join(',');
  defaults.groups.admin.allowIm = true;
  defaults.groups.admin.allowMpim = true;
  defaults.groups.admin.manualUserIds = uniqueList(input.coreDevSlackUserIds ?? []).join(',');
  defaults.groups.admin.slackUserGroupHandle = input.coreDevSlackUserGroup?.trim() ?? '';

  return toResolvedAccessControlConfig(defaults, input.ownerSlackUserIds);
}

export function toResolvedAccessControlConfig(
  settings: Partial<AccessControlSettings> | undefined,
  ownerSlackUserIds: string[],
): AccessControlConfig {
  const hydrated = hydrateAccessControlSettings(settings);

  return {
    mode: hydrated.mode,
    groups: {
      viewer: {
        key: 'viewer',
        ...hydrated.groups.viewer,
        resolvedUserIds: parseDelimitedIds(hydrated.groups.viewer.manualUserIds),
      },
      reviewer: {
        key: 'reviewer',
        ...hydrated.groups.reviewer,
        resolvedUserIds: parseDelimitedIds(hydrated.groups.reviewer.manualUserIds),
      },
      builder: {
        key: 'builder',
        ...hydrated.groups.builder,
        resolvedUserIds: parseDelimitedIds(hydrated.groups.builder.manualUserIds),
      },
      admin: {
        key: 'admin',
        ...hydrated.groups.admin,
        resolvedUserIds: uniqueList([...ownerSlackUserIds, ...parseDelimitedIds(hydrated.groups.admin.manualUserIds)]),
      },
    },
  };
}

export function resolveRequiredAccessLevel(intent: WorkflowIntent): AccessLevel {
  switch (intent) {
    case 'PR_REVIEW':
      return 'reviewer';
    case 'IMPLEMENTATION':
    case 'OWNER_AUTOPILOT':
      return 'builder';
    case 'DEPLOY':
    case 'DEV_ASSIST':
      return 'admin';
    case 'INFORMATIONAL':
    case 'CONVERSATIONAL':
    case 'UNKNOWN':
    case 'NONE':
    default:
      return 'viewer';
  }
}

export function getAdminUserIds(config: AppConfig): string[] {
  if (config.accessControl) {
    return uniqueList([...config.ownerSlackUserIds, ...config.accessControl.groups.admin.resolvedUserIds]);
  }
  return uniqueList([...config.ownerSlackUserIds, ...(config.coreDevSlackUserIds ?? [])]);
}

export function getConfiguredAccessControl(config: AppConfig): AccessControlConfig {
  return (
    config.accessControl ??
    buildLegacyAccessControlConfig({
      ownerSlackUserIds: config.ownerSlackUserIds,
      coreDevSlackUserIds: config.coreDevSlackUserIds,
      coreDevSlackUserGroup: config.coreDevSlackUserGroup,
      allowedChannelsForBugFix: config.allowedChannelsForBugFix,
    })
  );
}

export function setResolvedGroupMembers(params: {
  config: AppConfig;
  groupKey: AccessGroupKey;
  members: string[];
}): void {
  const accessControl = getConfiguredAccessControl(params.config);
  const manualUserIds = parseDelimitedIds(accessControl.groups[params.groupKey].manualUserIds);
  const nextMembers =
    params.groupKey === 'admin'
      ? uniqueList([...params.config.ownerSlackUserIds, ...manualUserIds, ...params.members])
      : uniqueList([...manualUserIds, ...params.members]);

  accessControl.groups[params.groupKey].resolvedUserIds = nextMembers;
  params.config.accessControl = accessControl;
}

function channelAllowed(
  group: AccessControlConfig['groups'][AccessGroupKey],
  channelId: string,
  channelType?: string,
): boolean {
  if (channelType === 'im') {
    return group.allowIm;
  }
  if (channelType === 'mpim') {
    return group.allowMpim;
  }

  return parseDelimitedIds(group.allowedChannelIds).includes(channelId);
}

export function evaluateAccess(params: {
  config: AppConfig;
  userId: string;
  channelId: string;
  channelType?: string;
  requiredLevel: AccessLevel;
}): AccessDecision {
  const { config, userId, channelId, channelType, requiredLevel } = params;

  if (config.ownerSlackUserIds.includes(userId)) {
    return {
      allowed: true,
      ownerBypass: true,
      requiredLevel,
      matchedGroups: ['admin'],
      userGroups: ['admin'],
    };
  }

  const accessControl = getConfiguredAccessControl(config);
  const userGroups = ACCESS_GROUP_KEYS.filter(key => accessControl.groups[key].resolvedUserIds.includes(userId));
  const matchedGroups = userGroups.filter(key => channelAllowed(accessControl.groups[key], channelId, channelType));
  const allowed = matchedGroups.some(key => ACCESS_RANK[key] >= ACCESS_RANK[requiredLevel]);

  return {
    allowed,
    ownerBypass: false,
    requiredLevel,
    matchedGroups,
    userGroups,
    reason: allowed
      ? undefined
      : `Access denied. This request needs ${requiredLevel} access in this channel. Ask an admin to update Watchtower Settings.`,
  };
}
