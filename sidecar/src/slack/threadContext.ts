import type { WebClient } from '@slack/web-api';
import type { SlackFileAttachment } from './imageDownloader.js';

export type ThreadMessage = {
  text: string;
  user: string;
  ts: string;
  files?: SlackFileAttachment[];
};

export async function fetchThreadContext(client: WebClient, channel: string, threadTs: string): Promise<ThreadMessage[]> {
  const response = await client.conversations.replies({
    channel,
    ts: threadTs,
    inclusive: true,
    limit: 200,
  });

  const messages = response.messages ?? [];
  return messages.map(message => {
    const rawFiles = (message as Record<string, unknown>).files as
      | Array<Record<string, unknown>>
      | undefined;

    const files: SlackFileAttachment[] | undefined = rawFiles
      ?.filter(
        f =>
          typeof f.id === 'string' &&
          typeof f.name === 'string' &&
          typeof f.mimetype === 'string' &&
          typeof f.url_private_download === 'string'
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
