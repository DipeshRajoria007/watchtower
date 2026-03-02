import type { NormalizedTask, WorkflowResult } from '../types/contracts.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';

export async function runUnknownTaskWorkflow(task: NormalizedTask): Promise<WorkflowResult> {
  notifyDesktop(
    'Watchtower unknown task',
    `No configured workflow matched channel=${task.event.channelId} thread=${task.event.threadTs}`
  );

  return {
    workflow: 'UNKNOWN',
    status: 'SKIPPED',
    message: 'Unknown task; desktop notification only.',
    notifyDesktop: true,
    slackPosted: false,
  };
}
