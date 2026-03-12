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
  track: UnknownReplyTrack;
  seriousContext: boolean;
};

type UnknownReplyTrack = 'social_banter' | 'task_clarifier';

const TECHNICAL_SIGNAL_PATTERNS = [
  /\b(pr|pull request|review|bug|fix|regression|issue|error|exception|stack|trace|log)\b/i,
  /\b(repo|repository|branch|commit|merge|deploy|release|prod|staging|hotfix|rollback)\b/i,
  /\b(ci|pipeline|test|build|ticket|jira)\b/i,
  /https?:\/\/github\.com\//i,
  /https?:\/\/[a-z0-9.-]*atlassian\.net\//i,
  /`[^`]+`/,
] as const;

const ACTION_CUE_PATTERN =
  /\b(help|handle|do|build|ship|check|investigate|explain|summarize|draft|write|solve|debug|fix|review|test|look at|prove|proof|show|derive|calculate|compute|answer|respond|create|generate|prepare)\b/i;
const SOCIAL_CUE_PATTERN =
  /\b(lol|haha|hehe|better than|worse than|right\?|isn't that right|meme|roast|joke|banter|tea|gossip|vibe|mood)\b/i;
const SERIOUS_DIRECTIVE_PATTERN = /\b(professional|serious|formal|strict|no jokes?|no humour|no humor)\b/i;
const SERIOUS_HUMOR_MARKER_PATTERN =
  /\b(kpi|layoff|layoffs|budget|committee|boardroom|townhall|scope creep|surprise deliverable|trust issues|self-destruct|entropy|fun column|office-banter|workplace banter|corporate-jokes|natural force|smoke)\b/i;

const FALLBACK_REACTIONS: Record<PersonalityMode, string[]> = {
  dark_humor: ['skull', 'eyes', 'ghost', 'warning', 'satellite'],
  professional: ['eyes', 'memo', 'mag', 'spiral_note_pad'],
  friendly: ['wave', 'thinking_face', 'sparkles', 'eyes'],
  chaos: ['dizzy_face', 'boom', 'cyclone', 'fire'],
};

const FALLBACK_REPLIES: Record<PersonalityMode, Record<UnknownReplyTrack, string[]>> = {
  dark_humor: {
    social_banter: [
      'noted. the quarterly banter deck is strong today.',
      'solid boardroom energy. i support this message in principle.',
      'approved for hallway gossip tier. carry on.',
      'i respect the confidence. hr-safe chaos, nicely done.',
    ],
    task_clarifier: [
      'i can run with this, but i need one clear outcome.',
      'give me the exact deliverable and i will handle execution.',
      'this is direction-adjacent. name the concrete next step.',
      'i can action it once the ask is specific.',
    ],
  },
  professional: {
    social_banter: [
      'message received.',
      'noted.',
      'acknowledged.',
      'understood.',
    ],
    task_clarifier: [
      'i can take this forward. share the exact outcome you want.',
      'please specify the single deliverable and owner expectation.',
      'i need one concrete next step to execute.',
      'define the target result and i will proceed.',
    ],
  },
  friendly: {
    social_banter: [
      'fair point. this is premium office-banter material.',
      'noted and appreciated. strong team-chat energy.',
      'haha, logged in the fun column.',
      'valid vibe. carrying this conversation with a smile.',
    ],
    task_clarifier: [
      'happy to help. tell me the exact outcome you want next.',
      'i can do this. share one clear deliverable.',
      'give me the specific next step and i am on it.',
      'point me at the exact result and i will run with it.',
    ],
  },
  chaos: {
    social_banter: [
      'certified corporate chaos. approved by the imaginary steering committee.',
      'this has startup townhall energy and i respect it.',
      'excellent entropy, still hr-safe. carry on.',
      'boardroom turbulence detected. morale remains green.',
    ],
    task_clarifier: [
      'chaos accepted. give me one crisp outcome to execute.',
      'i can ship this, but i need a specific target.',
      'high entropy ask. drop one concrete next step.',
      'send the exact deliverable and i will launch.',
    ],
  },
};

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function classifyUnknownReplyTrack(texts: string[]): UnknownReplyTrack {
  const normalized = texts
    .join('\n')
    .replace(/<@[^>]+>/g, ' ')
    .toLowerCase();

  if (!normalized.trim()) {
    return 'social_banter';
  }

  if (TECHNICAL_SIGNAL_PATTERNS.some(pattern => pattern.test(normalized))) {
    return 'task_clarifier';
  }

  if (SOCIAL_CUE_PATTERN.test(normalized)) {
    return 'social_banter';
  }

  if (ACTION_CUE_PATTERN.test(normalized)) {
    return 'task_clarifier';
  }

  return 'social_banter';
}

function isSeriousUnknownContext(task: NormalizedTask, texts: string[], track: UnknownReplyTrack): boolean {
  const normalized = texts
    .join('\n')
    .replace(/<@[^>]+>/g, ' ')
    .toLowerCase();

  if (task.isOwnerAuthor || task.mentionType === 'owner' || task.prContext) {
    return true;
  }
  if (track === 'task_clarifier') {
    return true;
  }
  if (SERIOUS_DIRECTIVE_PATTERN.test(normalized)) {
    return true;
  }
  return TECHNICAL_SIGNAL_PATTERNS.some(pattern => pattern.test(normalized));
}

function buildFallbackUnknownReply(
  task: NormalizedTask,
  personalityMode: PersonalityMode,
  track: UnknownReplyTrack
): UnknownReply {
  const seed = hashString(`${task.event.userId}:${task.event.text}:${task.event.eventTs}`);
  const replies = FALLBACK_REPLIES[personalityMode][track];
  const variant = seed % replies.length;
  const reactions = FALLBACK_REACTIONS[personalityMode];
  const reaction = reactions[seed % reactions.length];

  return {
    reply: replies[variant],
    reaction,
    track,
    seriousContext: personalityMode === 'professional',
  };
}

function sanitizeReaction(reaction: string | undefined, seriousContext = false): string {
  if (!reaction) {
    return seriousContext ? 'eyes' : 'skull';
  }
  const value = reaction.trim().toLowerCase();
  if (seriousContext) {
    if (['eyes', 'memo', 'mag', 'spiral_note_pad', 'white_check_mark'].includes(value)) {
      return value;
    }
    return 'eyes';
  }
  if (/^[a-z0-9_+-]+$/.test(value)) {
    return value;
  }
  return 'skull';
}

function normalizeSeriousReply(reply: string): string {
  const collapsed = reply.trim().replace(/\s+/g, ' ');
  if (!collapsed) {
    return '';
  }

  const wasQuestion = collapsed.includes('?');
  let candidate = collapsed.replace(
    /\s*(?:[;,.-]|\s+or\b|\s+but\b|\s+before\b)\s+[^.?!]*(?:kpi|layoff|layoffs|budget|committee|boardroom|townhall|scope creep|surprise deliverable|trust issues|self-destruct|entropy|fun column|office-banter|workplace banter|corporate-jokes|natural force|smoke)[^.?!]*[.?!]?$/i,
    ''
  ).trim();

  if (!candidate) {
    candidate = collapsed;
  }

  const plainSentences = candidate
    .split(/(?<=[.?!])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean)
    .filter(sentence => !SERIOUS_HUMOR_MARKER_PATTERN.test(sentence));

  if (plainSentences.length > 0) {
    candidate = plainSentences.join(' ');
  }

  const questionMatch = candidate.match(/^[^?]*\?/);
  if (questionMatch && !SERIOUS_HUMOR_MARKER_PATTERN.test(questionMatch[0])) {
    return questionMatch[0].trim();
  }

  const sentenceMatch = candidate.match(/^[^.?!]*[.?!]?/);
  const fallback = (sentenceMatch?.[0] ?? candidate).trim();
  if (!fallback) {
    return '';
  }
  if (wasQuestion && !fallback.endsWith('?')) {
    return `${fallback}?`;
  }
  return fallback;
}

function sanitizeReply(
  reply: string | undefined,
  userId: string,
  track: UnknownReplyTrack,
  seriousContext = false
): string {
  const trimmed = seriousContext ? normalizeSeriousReply(reply ?? '') : (reply ?? '').trim();
  if (trimmed.length > 0) {
    return `<@${userId}> ${trimmed}`;
  }
  if (track === 'task_clarifier') {
    return `<@${userId}> share the exact outcome you want me to handle.`;
  }
  return `<@${userId}> noted.`;
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
  const threadTexts = [task.event.text, ...threadMessages.map(message => message.text)];
  const track = classifyUnknownReplyTrack(threadTexts);
  const seriousContext = isSeriousUnknownContext(task, threadTexts, track);
  const effectivePersonalityMode = seriousContext ? 'professional' : personalityMode;
  const threadContext = threadTexts
    .filter(Boolean)
    .join('\n---\n');

  const prompt = `
${buildMentionSystemPrompt({ task, workflow: 'UNKNOWN', personalityMode: effectivePersonalityMode })}

Generate a Slack reply for an unknown/random bot mention.

Rules:
1. Tone profile: ${toneForPersonalityMode(effectivePersonalityMode)}
2. Context track: ${track}
3. Serious context: ${seriousContext ? 'yes' : 'no'}.
4. If serious context is yes, keep the reply strictly professional. No jokes, sarcasm, banter, or playful asides.
5. If track is social_banter and serious context is no, keep it brief and natural. Do not invent corporate one-liners.
6. If track is task_clarifier, ask for one missing detail naturally. Do not repeat boilerplate like "PR/bug/CI pipeline" triads.
7. Safe: no hate, no abuse, no threats.
8. Keep reply to max ${seriousContext ? 18 : 24} words.
9. Reply text must NOT include user mention. Mention is added externally.
10. Pick one fitting Slack emoji reaction name (without colons). If serious context is yes, use only neutral reactions like eyes, memo, mag, spiral_note_pad.

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
      effectivePersonalityMode,
      track,
      seriousContext,
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
      seriousContext,
    },
  });

  if (!result.ok || !result.parsedJson) {
    return buildFallbackUnknownReply(task, effectivePersonalityMode, track);
  }

  const reply = String(result.parsedJson.reply ?? '').trim();
  const reaction = sanitizeReaction(String(result.parsedJson.reaction ?? ''), seriousContext);
  if (!reply) {
    return buildFallbackUnknownReply(task, effectivePersonalityMode, track);
  }

  return { reply, reaction, track, seriousContext };
}

function toneForPersonalityMode(mode: PersonalityMode): string {
  if (mode === 'professional') {
    return 'crisp, workplace-safe, concise, lightly personable';
  }
  if (mode === 'friendly') {
    return 'warm, polite, practical, positive';
  }
  if (mode === 'chaos') {
    return 'playful corporate-chaotic, concise, still safe';
  }
  return 'dry dark humor with corporate flavor, witty, short, safe';
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
  const seriousContext = generated.seriousContext;
  const effectiveMode = seriousContext ? 'professional' : mode;
  const replyText = sanitizeReply(generated.reply, task.event.userId, generated.track, seriousContext);
  const reaction = sanitizeReaction(generated.reaction, seriousContext);

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
    message: `Unknown task; Codex-generated ${effectiveMode}/${generated.track} Slack reply sent.`,
    notifyDesktop: true,
    slackPosted: Boolean(postedTs),
  };
}
