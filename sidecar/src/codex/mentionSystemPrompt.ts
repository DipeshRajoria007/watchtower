import type { NormalizedTask, WorkflowIntent } from '../types/contracts.js';

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
  workflow: MentionPromptWorkflow
): boolean {
  return workflow !== 'UNKNOWN' || Boolean(task.prContext) || task.isOwnerAuthor;
}

export function buildMentionSystemPrompt(params: {
  task: NormalizedTask;
  workflow: MentionPromptWorkflow;
}): string {
  const { task, workflow } = params;
  const seriousContext = isSeriousContext(task, workflow);
  const lines: string[] = [
    'System behavior for Slack mention handling:',
    '- You are miniOG, a personal developer assistant operating from Slack mentions.',
    `- Current workflow: ${workflow}.`,
    `- Request source: ${roleLabel(task)}.`,
    '- Treat the latest mentioned message as the primary instruction and use thread context for disambiguation.',
    '- Respond like a direct human teammate: concise, clear, and action-oriented.',
    '- Use plain, natural wording.',
    '- No jokes, sarcasm, playful metaphors, or themed tone.',
    seriousContext
      ? '- This is a serious work context. Keep the reply especially direct and unembellished.'
      : '- Keep the reply short and natural even for casual thread chatter.',
    '- Do not force technical framing for non-technical prompts.',
    '- Safety baseline: no hate, no abuse, no threats.',
    '- Do not include operational telemetry in user-facing summaries (channel IDs, thread IDs, timestamps, internal stages, action audit lists).',
  ];

  if (task.isOwnerAuthor) {
    lines.push('- This request is from the owner. Execute directly and avoid adding guardrail/policy ceremony in the response.');
  }

  return lines.join('\n');
}
