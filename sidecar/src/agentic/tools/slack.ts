import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { fetchThreadContext } from '../../slack/threadContext.js';

const threadContextArgsSchema = z.object({});

export const getThreadContextTool: ToolDefinition<typeof threadContextArgsSchema> = {
  name: 'get_thread_context',
  description:
    'Fetch the prior messages in this Slack thread (parent + replies). Use when you need context that is not in the current request. Returns a newline-joined transcript with author labels.',
  // chat is the lowest-tier capability; gating on it means everyone who can
  // talk to miniOG at all can read their own thread context.
  capability: 'chat',
  inputSchema: threadContextArgsSchema,
  inputJsonSchema: { type: 'object', properties: {}, required: [] },
  handler: async (_args, context): Promise<ToolResult> => {
    try {
      const messages = await fetchThreadContext(
        context.slack,
        context.task.event.channelId,
        context.task.event.threadTs,
      );
      if (!messages || messages.length === 0) {
        return { content: 'Thread has no prior messages.', data: { messageCount: 0 } };
      }
      const transcript = messages
        .map(m => `${m.user ?? 'unknown'}: ${(m.text ?? '').replace(/\s+/g, ' ').slice(0, 500)}`)
        .join('\n');
      return { content: transcript, data: { messageCount: messages.length } };
    } catch (err) {
      return { content: `Could not fetch thread context: ${String(err)}`, isError: true };
    }
  },
};

const postReplyArgsSchema = z.object({
  text: z.string().min(1).max(4000),
});

export const postSlackReplyTool: ToolDefinition<typeof postReplyArgsSchema> = {
  name: 'post_slack_reply',
  description:
    'Post your final reply to the user in this Slack thread. Call this exactly once when you are done thinking. After this call the conversation ends. Keep replies concise and human; use Slack markdown (`code`, *bold*, _italic_, bullets).',
  capability: 'chat',
  inputSchema: postReplyArgsSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Markdown-formatted Slack reply.', maxLength: 4000 },
    },
    required: ['text'],
  },
  handler: async (args, context): Promise<ToolResult> => {
    try {
      await context.slack.chat.postMessage({
        channel: context.task.event.channelId,
        thread_ts: context.task.event.threadTs,
        text: args.text,
      });
      return { content: 'Reply posted.', terminal: true, data: { replyLength: args.text.length } };
    } catch (err) {
      return { content: `Could not post reply: ${String(err)}`, isError: true };
    }
  },
};
