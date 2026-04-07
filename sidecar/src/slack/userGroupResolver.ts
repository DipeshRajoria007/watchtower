import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';

export interface ResolvedSlackUserGroup {
  id?: string;
  members: string[];
}

/**
 * Resolves a Slack user group handle (e.g., "core-dev") to its member user IDs.
 * Uses usergroups.list to find the group by handle, then usergroups.users.list
 * to fetch its members.
 */
export async function resolveUserGroup(slack: WebClient, handle: string): Promise<ResolvedSlackUserGroup> {
  const normalizedHandle = handle.replace(/^@/, '').trim().toLowerCase();
  if (!normalizedHandle) {
    return { members: [] };
  }

  try {
    const groupsResponse = await slack.usergroups.list({ include_disabled: false });
    const groups = groupsResponse.usergroups ?? [];
    const group = groups.find(g => g.handle?.toLowerCase() === normalizedHandle);

    if (!group?.id) {
      logger.warn({ handle: normalizedHandle }, 'Slack user group not found by handle');
      return { members: [] };
    }

    const membersResponse = await slack.usergroups.users.list({ usergroup: group.id });
    const members = membersResponse.users ?? [];

    logger.info(
      { handle: normalizedHandle, groupId: group.id, memberCount: members.length },
      'resolved Slack user group members',
    );

    return {
      id: group.id,
      members,
    };
  } catch (error) {
    logger.error({ handle: normalizedHandle, error: String(error) }, 'failed to resolve Slack user group');
    return { members: [] };
  }
}

export async function resolveUserGroupMembers(slack: WebClient, handle: string): Promise<string[]> {
  const resolved = await resolveUserGroup(slack, handle);
  return resolved.members;
}
