import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult } from '../types/contracts.js';
import { runBugFixWorkflow } from '../workflows/bugFixWorkflow.js';
import { runPrReviewWorkflow } from '../workflows/prReviewWorkflow.js';
import { runUnknownTaskWorkflow } from '../workflows/unknownTaskWorkflow.js';

export async function routeTask(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
}): Promise<WorkflowResult> {
  const { task, config, slack } = params;

  if (task.intent === 'PR_REVIEW') {
    return runPrReviewWorkflow({ task, config, slack });
  }

  if (task.intent === 'BUG_FIX') {
    return runBugFixWorkflow({ task, config, slack });
  }

  return runUnknownTaskWorkflow(task);
}
