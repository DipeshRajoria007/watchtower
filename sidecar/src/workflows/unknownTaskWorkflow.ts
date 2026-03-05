import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  NormalizedTask,
  PersonalityMode,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import { runCodex } from '../codex/runCodex.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { fetchThreadContext } from '../slack/threadContext.js';

type UnknownReply = {
  reply: string;
  reaction: string;
};

const FALLBACK_REACTIONS: Record<PersonalityMode, string[]> = {
  dark_humor: ['skull', 'eyes', 'ghost', 'warning', 'satellite'],
  professional: ['memo', 'mag', 'warning', 'spiral_note_pad'],
  friendly: ['wave', 'thinking_face', 'sparkles', 'eyes'],
  chaos: ['dizzy_face', 'boom', 'cyclone', 'fire'],
};

const FALLBACK_REPLIES: Record<PersonalityMode, string[]> = {
  dark_humor: [
    'bold request, bold liability. send a concrete bug or PR before i become a case study.',
    'you summoned chaos without requirements. drop a real task and i will get surgical.',
    'this request reads like a postmortem teaser. give me a PR or bug and i will haunt it.',
    'i heard your ask and compliance flinched. send clear scope and i will execute.',
    'respect for the audacity, but i only run concrete tasks. bug ID or PR URL please.',
  ],
  professional: [
    'request received. please provide a concrete PR URL or bug context so i can execute.',
    'i need actionable scope to proceed. share the target repo, issue, or PR.',
    'unable to route this safely without specifics. please provide a defined engineering task.',
    'this appears out of workflow scope. add concrete acceptance criteria and i can continue.',
    'please rephrase with clear intent and references so automation can proceed reliably.',
  ],
  friendly: [
    'i can help, but i need a concrete bug or PR to start. share one and i am on it.',
    'almost there. send a clear task with repo/PR details and i will run it.',
    'happy to jump in. give me specific context so i can do useful work.',
    'could you share the exact bug or PR link? then i can take it from there.',
    'i need one concrete engineering task to begin. once shared, i will execute.',
  ],
  chaos: [
    'chaos acknowledged, mission unclear. give me a real bug or PR before reality forks.',
    'request received from the void. attach concrete scope and i will launch.',
    'i can improvise, but prod deserves specifics. send target + intent.',
    'this is high entropy and low instructions. feed me exact context.',
    'chaos mode is ready, but i still need coordinates: repo, bug, or PR.',
  ],
};

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function summarizeUserIntent(text: string): string {
  const cleaned = text
    .replace(/<@[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return 'that';
  }
  return cleaned.split(' ').slice(0, 8).join(' ');
}

function buildFallbackUnknownReply(task: NormalizedTask, personalityMode: PersonalityMode): UnknownReply {
  const snippet = summarizeUserIntent(task.event.text);
  const seed = hashString(`${task.event.userId}:${task.event.text}:${task.event.eventTs}`);
  const replies = FALLBACK_REPLIES[personalityMode];
  const variant = seed % replies.length;
  const reactions = FALLBACK_REACTIONS[personalityMode];
  const reaction = reactions[seed % reactions.length];

  return {
    reply: `${replies[variant]} (${snippet})`,
    reaction,
  };
}

function sanitizeReaction(reaction: string | undefined): string {
  if (!reaction) {
    return 'skull';
  }
  const value = reaction.trim().toLowerCase();
  if (/^[a-z0-9_+-]+$/.test(value)) {
    return value;
  }
  return 'skull';
}

function sanitizeReply(reply: string | undefined, userId: string): string {
  const trimmed = (reply ?? '').trim();
  if (trimmed.length > 0) {
    return `<@${userId}> ${trimmed}`;
  }
  return `<@${userId}> your request detonated my paranoia module. give me a concrete task so i can do useful damage.`;
}

async function generateUnknownReplyWithCodex(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  personalityMode: PersonalityMode;
  logStep?: WorkflowStepLogger;
}): Promise<UnknownReply> {
  const { task, config, slack, personalityMode, logStep } = params;

  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs).catch(() => []);
  const threadContext = [task.event.text, ...threadMessages.map(message => message.text)]
    .filter(Boolean)
    .join('\n---\n');

  const prompt = `
${buildMentionSystemPrompt({ task, workflow: 'UNKNOWN', personalityMode })}

Generate a Slack reply for an unknown/random bot mention.

Rules:
1. Tone profile: ${toneForPersonalityMode(personalityMode)}
2. Safe: no hate, no abuse, no threats.
3. Keep reply to max 24 words.
4. Reply text must NOT include user mention. Mention is added externally.
5. Pick one fitting Slack emoji reaction name (without colons), e.g. skull, eyes, ghost, melting_face.

Context:
- Mention text: ${task.event.text}
- Thread context:
${threadContext || '(empty)'}

Return strict JSON with keys:
- reply (string)
- reaction (string)
`.trim();

  const request: CodexRunRequest = {
    cwd: process.cwd(),
    prompt,
    timeoutMs: Math.min(config.workflowTimeouts.prReviewMs, 120_000),
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/unknown-task-result.schema.json'),
    reasoningEffort: 'low',
    onLog: logStep,
  };

  logStep?.({
    stage: 'unknown.codex.start',
    message: 'Generating unknown-task reply with Codex (low reasoning effort).',
    data: {
      timeoutMs: request.timeoutMs,
      threadMessages: threadMessages.length,
      personalityMode,
    },
  });

  const result = await runCodex(request);

  logStep?.({
    stage: 'unknown.codex.finish',
    message: 'Unknown-task Codex generation finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: {
      ok: result.ok,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      parsedJson: Boolean(result.parsedJson),
    },
  });

  if (!result.ok || !result.parsedJson) {
    return buildFallbackUnknownReply(task, personalityMode);
  }

  const reply = String(result.parsedJson.reply ?? '').trim();
  const reaction = sanitizeReaction(String(result.parsedJson.reaction ?? ''));
  if (!reply) {
    return buildFallbackUnknownReply(task, personalityMode);
  }

  return { reply, reaction };
}

function toneForPersonalityMode(mode: PersonalityMode): string {
  if (mode === 'professional') {
    return 'crisp, neutral, technical, no jokes';
  }
  if (mode === 'friendly') {
    return 'warm, polite, practical';
  }
  if (mode === 'chaos') {
    return 'playful-chaotic but still concise and safe';
  }
  return 'dark/suspicious humor, witty, short';
}

export async function runUnknownTaskWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  personalityMode?: PersonalityMode;
  logStep?: WorkflowStepLogger;
  generateUnknownReply?: (input: {
    task: NormalizedTask;
    config: AppConfig;
    slack: WebClient;
    personalityMode: PersonalityMode;
    logStep?: WorkflowStepLogger;
  }) => Promise<UnknownReply>;
}): Promise<WorkflowResult> {
  const { task, config, slack, personalityMode, logStep, generateUnknownReply } = params;
  const mode = personalityMode ?? 'dark_humor';

  logStep?.({
    stage: 'unknown.notify.desktop',
    message: 'No configured workflow matched; generating personality-aware reply with Codex and notifying desktop.',
    level: 'WARN',
    data: {
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      personalityMode: mode,
    },
  });

  const generator = generateUnknownReply ?? generateUnknownReplyWithCodex;
  const generated = await generator({ task, config, slack, personalityMode: mode, logStep });
  const replyText = sanitizeReply(generated.reply, task.event.userId);
  const reaction = sanitizeReaction(generated.reaction);

  let postedTs: string | undefined;
  try {
    const response = await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: replyText,
    });
    postedTs = response.ts;

    logStep?.({
      stage: 'unknown.slack.reply_posted',
      message: 'Posted unknown-task reply in Slack thread.',
      data: {
        userId: task.event.userId,
      },
    });
  } catch (error) {
    logStep?.({
      stage: 'unknown.slack.reply_failed',
      message: 'Failed to post unknown-task reply in Slack thread.',
      level: 'ERROR',
      data: {
        error: String(error),
      },
    });
  }

  if (postedTs) {
    try {
      await slack.reactions.add({
        channel: task.event.channelId,
        timestamp: postedTs,
        name: reaction,
      });

      logStep?.({
        stage: 'unknown.slack.reaction_added',
        message: 'Added reaction to unknown-task reply.',
        data: {
          reaction,
        },
      });
    } catch (error) {
      logStep?.({
        stage: 'unknown.slack.reaction_failed',
        message: 'Failed to add reaction to unknown-task reply.',
        level: 'WARN',
        data: {
          error: String(error),
        },
      });
    }
  }

  notifyDesktop(
    'Watchtower unknown task',
    `No configured workflow matched channel=${task.event.channelId} thread=${task.event.threadTs}`
  );

  return {
    workflow: 'UNKNOWN',
    status: 'SKIPPED',
    message: `Unknown task; Codex-generated ${mode} Slack reply sent.`,
    notifyDesktop: true,
    slackPosted: Boolean(postedTs),
  };
}
