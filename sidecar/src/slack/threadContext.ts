import type { WebClient } from '@slack/web-api';
import type { SlackFileAttachment } from './imageDownloader.js';

export type ThreadMessage = {
  text: string;
  user: string;
  ts: string;
  files?: SlackFileAttachment[];
};

/**
 * Returns `false` if Slack reports the thread parent does not exist
 * (`thread_not_found`), `true` otherwise. Used by long-running workflows
 * (planner, multi-agent pipelines) to short-circuit before doing expensive
 * work whose output would be orphaned by a deleted parent — Slack silently
 * promotes thread-less replies to channel root, which manifests as junk
 * sitting at the top of the channel with no source mention above it.
 *
 * Any error OTHER than `thread_not_found` is re-thrown so we don't silently
 * swallow rate limits, auth failures, or network blips as "parent gone".
 */
export async function assertThreadParentExists(client: WebClient, channel: string, threadTs: string): Promise<boolean> {
  try {
    await client.conversations.replies({ channel, ts: threadTs, inclusive: true, limit: 1 });
    return true;
  } catch (error) {
    const code =
      error && typeof error === 'object'
        ? ((error as { data?: { error?: unknown } }).data?.error as string | undefined)
        : undefined;
    if (code === 'thread_not_found' || code === 'message_not_found') {
      return false;
    }
    throw error;
  }
}

export async function fetchThreadContext(
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<ThreadMessage[]> {
  const response = await client.conversations.replies({
    channel,
    ts: threadTs,
    inclusive: true,
    limit: 200,
  });

  const messages = response.messages ?? [];
  return messages.map(message => {
    const rawFiles = (message as Record<string, unknown>).files as Array<Record<string, unknown>> | undefined;

    const files: SlackFileAttachment[] | undefined = rawFiles
      ?.filter(
        f =>
          typeof f.id === 'string' &&
          typeof f.name === 'string' &&
          typeof f.mimetype === 'string' &&
          typeof f.url_private_download === 'string',
      )
      .map(f => ({
        id: f.id as string,
        name: f.name as string,
        mimetype: f.mimetype as string,
        url_private_download: f.url_private_download as string,
      }));

    return {
      text: message.text ?? '',
      user: message.user ?? '',
      ts: message.ts ?? '',
      files: files && files.length > 0 ? files : undefined,
    };
  });
}
