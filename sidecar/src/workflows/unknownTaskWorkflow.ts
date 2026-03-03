import type { NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';

export async function runUnknownTaskWorkflow(
  task: NormalizedTask,
  logStep?: WorkflowStepLogger
): Promise<WorkflowResult> {
  logStep?.({
    stage: 'unknown.notify.desktop',
    message: 'No configured workflow matched; desktop notification emitted.',
    level: 'WARN',
    data: {
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
    },
  });

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
