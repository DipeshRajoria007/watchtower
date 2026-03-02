import type { WebClient } from '@slack/web-api';

export type ThreadMessage = {
  text: string;
  user: string;
  ts: string;
};

export async function fetchThreadContext(client: WebClient, channel: string, threadTs: string): Promise<ThreadMessage[]> {
  const response = await client.conversations.replies({
    channel,
    ts: threadTs,
    inclusive: true,
    limit: 200,
  });

  const messages = response.messages ?? [];
  return messages.map(message => ({
    text: message.text ?? '',
    user: message.user ?? '',
    ts: message.ts ?? '',
  }));
}
