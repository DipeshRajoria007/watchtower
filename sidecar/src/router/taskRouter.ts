import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  NormalizedTask,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';
import { runBugFixWorkflow } from '../workflows/bugFixWorkflow.js';
import { runDevAssistWorkflow } from '../workflows/devAssistWorkflow.js';
import { runOwnerAutopilotWorkflow } from '../workflows/ownerAutopilotWorkflow.js';
import { runPmTaskWorkflow } from '../workflows/pmTaskWorkflow.js';
import { runPrReviewWorkflow } from '../workflows/prReviewWorkflow.js';
import { runUnknownTaskWorkflow } from '../workflows/unknownTaskWorkflow.js';

export async function routeTask(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store: JobStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, jobId, logStep } = params;

  if (task.intent === 'PR_REVIEW') {
    return runPrReviewWorkflow({ task, config, slack, store, jobId, logStep });
  }

  if (task.intent === 'BUG_FIX') {
    return runBugFixWorkflow({ task, config, slack, store, jobId, logStep });
  }

  if (task.intent === 'PM_TASK') {
    return runPmTaskWorkflow({ task, config, slack, store, jobId, logStep });
  }

  if (task.intent === 'OWNER_AUTOPILOT') {
    return runOwnerAutopilotWorkflow({ task, config, slack, store, jobId, logStep });
  }

  if (task.intent === 'DEV_ASSIST') {
    return runDevAssistWorkflow({ task, config, slack, store, logStep });
  }

  return runUnknownTaskWorkflow({ task, config, slack, logStep });
}
