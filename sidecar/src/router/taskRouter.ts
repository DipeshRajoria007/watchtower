import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runBugFixWorkflow } from '../workflows/bugFixWorkflow.js';
import { runOwnerAutopilotWorkflow } from '../workflows/ownerAutopilotWorkflow.js';
import { runPrReviewWorkflow } from '../workflows/prReviewWorkflow.js';
import { runUnknownTaskWorkflow } from '../workflows/unknownTaskWorkflow.js';

export async function routeTask(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, config, slack, logStep } = params;

  if (task.intent === 'PR_REVIEW') {
    return runPrReviewWorkflow({ task, config, slack, logStep });
  }

  if (task.intent === 'BUG_FIX') {
    return runBugFixWorkflow({ task, config, slack, logStep });
  }

  if (task.intent === 'OWNER_AUTOPILOT') {
    return runOwnerAutopilotWorkflow({ task, config, slack, logStep });
  }

  return runUnknownTaskWorkflow(task, logStep);
}
