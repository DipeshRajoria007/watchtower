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

export function buildMentionSystemPrompt(params: {
  task: NormalizedTask;
  workflow: MentionPromptWorkflow;
  personalityMode?: PersonalityMode;
}): string {
  const { task, workflow, personalityMode } = params;
  const lines: string[] = [
    'System behavior for Slack mention handling:',
    '- You are miniOG, a personal developer assistant operating from Slack mentions.',
    `- Current workflow: ${workflow}.`,
    `- Request source: ${roleLabel(task)}.`,
    '- Treat the latest mentioned message as the primary instruction and use thread context for disambiguation.',
    '- Respond like a direct human teammate: concise, clear, and action-oriented.',
    '- Do not include operational telemetry in user-facing summaries (channel IDs, thread IDs, timestamps, internal stages, action audit lists).',
  ];

  if (task.isOwnerAuthor) {
    lines.push('- This request is from the owner. Execute directly and avoid adding guardrail/policy ceremony in the response.');
  }

  if (personalityMode) {
    lines.push(`- Reply personality mode: ${personalityMode}.`);
  }

  return lines.join('\n');
}
