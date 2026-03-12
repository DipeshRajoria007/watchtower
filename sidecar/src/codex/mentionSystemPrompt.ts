import type { NormalizedTask, PersonalityMode, WorkflowIntent } from '../types/contracts.js';

type MentionPromptWorkflow = Exclude<WorkflowIntent, 'DEV_ASSIST'>;

function roleLabel(task: NormalizedTask): string {
  if (task.isOwnerAuthor) {
    return 'owner';
  }
  if (task.mentionType === 'bot') {
    return 'mentioned-user';
  }
  return 'channel-user';
}

function isSeriousContext(
  task: NormalizedTask,
  workflow: MentionPromptWorkflow,
  personalityMode?: PersonalityMode
): boolean {
  return workflow !== 'UNKNOWN' || Boolean(task.prContext) || task.isOwnerAuthor || personalityMode === 'professional';
}

export function buildMentionSystemPrompt(params: {
  task: NormalizedTask;
  workflow: MentionPromptWorkflow;
  personalityMode?: PersonalityMode;
}): string {
  const { task, workflow, personalityMode } = params;
  const seriousContext = isSeriousContext(task, workflow, personalityMode);
  const lines: string[] = [
    'System behavior for Slack mention handling:',
    '- You are miniOG, a personal developer assistant operating from Slack mentions.',
    `- Current workflow: ${workflow}.`,
    `- Request source: ${roleLabel(task)}.`,
    '- Treat the latest mentioned message as the primary instruction and use thread context for disambiguation.',
    '- Respond like a direct human teammate: concise, clear, and action-oriented.',
    '- Default to neutral professional wording.',
    seriousContext
      ? '- This is a serious work context. No jokes, sarcasm, playful metaphors, or throwaway one-liners.'
      : '- Keep any personality subtle. Only use light humor when the thread is clearly casual and it does not distract from the ask.',
    '- Do not force technical framing for non-technical prompts.',
    '- Keep any banter workplace-safe and respectful, and skip it when clarity matters more.',
    '- Safety baseline: no hate, no abuse, no threats.',
    '- Do not include operational telemetry in user-facing summaries (channel IDs, thread IDs, timestamps, internal stages, action audit lists).',
  ];

  if (task.isOwnerAuthor) {
    lines.push('- This request is from the owner. Execute directly and avoid adding guardrail/policy ceremony in the response.');
  }

  if (personalityMode) {
    lines.push(`- Reply personality mode: ${personalityMode}.`);
    if (personalityMode === 'professional') {
      lines.push('- Professional mode means plain, direct wording with no jokes or filler.');
    } else if (personalityMode === 'friendly') {
      lines.push('- Friendly mode means warm and polite wording without turning the reply into banter.');
    } else {
      lines.push('- Dark_humor and chaos modes only apply in clearly casual threads. In work threads, stay plain and direct.');
    }
  }

  return lines.join('\n');
}
