import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  NormalizedTask,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';
import { runDevAssistWorkflow } from '../workflows/devAssistWorkflow.js';
import { runOwnerAutopilotWorkflow } from '../workflows/ownerAutopilotWorkflow.js';
import { runPrReviewWorkflow } from '../workflows/prReviewWorkflow.js';
import { runUnknownTaskWorkflow } from '../workflows/unknownTaskWorkflow.js';
import { getWorkflowTemplates } from '../workflows/registry.js';
import { matchWorkflowTemplate } from '../workflows/matcher.js';
import { renderPromptTemplate } from '../workflows/renderer.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { resolveGithubTokenForCodex } from '../github/githubAuth.js';

export async function routeTask(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store: JobStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, jobId, logStep, signal } = params;

  if (task.intent === 'PR_REVIEW') {
    return runPrReviewWorkflow({ task, config, slack, store, jobId, logStep, signal });
  }

  if (task.intent === 'OWNER_AUTOPILOT') {
    return runOwnerAutopilotWorkflow({ task, config, slack, store, jobId, logStep, signal });
  }

  if (task.intent === 'DEV_ASSIST') {
    return runDevAssistWorkflow({ task, config, slack, store, logStep });
  }

  // Check file-based workflow templates before falling through to unknown
  const templates = getWorkflowTemplates();
  if (templates.length > 0) {
    const matched = matchWorkflowTemplate(task.event.text, templates);
    if (matched) {
      logStep?.({
        stage: 'router.template_matched',
        message: `Matched file-based workflow template: ${matched.name}`,
        data: { templateName: matched.name },
      });

      return runTemplateWorkflow({ task, config, slack, template: matched, logStep, signal });
    }
  }

  return runUnknownTaskWorkflow({ task, config, slack, logStep });
}

async function runTemplateWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  template: ReturnType<typeof getWorkflowTemplates>[number];
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, template, logStep, signal } = params;

  const prompt = renderPromptTemplate(template.promptTemplate, task, config);
  const cwd = config.repoPaths.newtonWeb; // Default to web repo; template environment could override

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: `Running workflow: ${template.name}`,
  }).catch(() => {});

  const githubToken = await resolveGithubTokenForCodex();
  const request: CodexRunRequest = {
    cwd,
    prompt,
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/owner-autopilot-result.schema.json'),
    githubToken,
    ...highReasoningProfile(getActiveBackendId()),
    onLog: logStep,
    signal,
  };

  const result = await runCodex(request);

  const summary = result.parsedJson?.summary
    ? String(result.parsedJson.summary)
    : result.lastMessage || 'Workflow completed.';

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: summary,
  }).catch(() => {});

  return {
    workflow: 'OWNER_AUTOPILOT',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    message: summary,
    notifyDesktop: false,
    slackPosted: true,
    result: result.parsedJson ?? {},
  };
}
