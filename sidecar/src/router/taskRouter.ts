import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  NormalizedTask,
  WorkflowIntent,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';
import { runDevAssistWorkflow } from '../workflows/devAssistWorkflow.js';
import { runImplementationWorkflow } from '../workflows/implementationWorkflow.js';
import { runInformationalWorkflow } from '../workflows/informationalWorkflow.js';
import { runConversationalWorkflow } from '../workflows/conversationalWorkflow.js';
import { runPrReviewWorkflow } from '../workflows/prReviewWorkflow.js';
import { runUnknownTaskWorkflow } from '../workflows/unknownTaskWorkflow.js';
import { getWorkflowTemplates } from '../workflows/registry.js';
import { matchWorkflowTemplate } from '../workflows/matcher.js';
import { renderPromptTemplate } from '../workflows/renderer.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { classifyWorkflowIntent } from './classifyIntent.js';
import { isPresencePing } from '../workflows/shared/workflowUtils.js';

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

  // DEV_ASSIST is deterministic (explicit wt/ prefix or natural alias) — route immediately.
  if (task.intent === 'DEV_ASSIST') {
    return runDevAssistWorkflow({ task, config, slack, store, logStep });
  }

  // Presence pings: cheap regex check, skip the AI classifier entirely.
  const userMessage = (task.event.text ?? '')
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (isPresencePing(userMessage)) {
    return runConversationalWorkflow({ task, config, slack, logStep });
  }

  // For all other intents, use AI to classify.
  // Pass mentionType so the classifier knows if this is a direct @miniOG mention
  // or an indirect @theOG mention (owner-mention triggers should be filtered for relevance).
  const hasPrUrl = Boolean(task.prContext);
  const classification = await classifyWorkflowIntent({
    userMessage,
    hasPrUrl,
    mentionType: task.mentionType,
    logStep,
  });

  if (classification.intent !== task.intent) {
    logStep?.({
      stage: 'router.classify.override',
      message: `AI classifier resolved intent: ${task.intent} → ${classification.intent} (confidence=${classification.confidence.toFixed(2)}).`,
      data: {
        originalIntent: task.intent,
        classifiedIntent: classification.intent,
        confidence: classification.confidence,
        reasoning: classification.reasoning,
      },
    });
  }

  const resolvedIntent: WorkflowIntent = classification.intent;

  // NONE = classifier determined this is human-to-human conversation, miniOG should stay silent
  if (resolvedIntent === 'NONE') {
    logStep?.({
      stage: 'router.silent',
      message: 'Classifier returned NONE — staying silent for this human-to-human conversation.',
      data: { reasoning: classification.reasoning },
    });
    return {
      workflow: 'NONE',
      status: 'SKIPPED',
      message: 'Staying silent — message is human-to-human conversation.',
      notifyDesktop: false,
      slackPosted: false,
    };
  }

  if (resolvedIntent === 'PR_REVIEW') {
    const routedTask = resolvedIntent !== task.intent ? { ...task, intent: resolvedIntent } : task;
    return runPrReviewWorkflow({ task: routedTask, config, slack, store, jobId, logStep, signal });
  }

  if (resolvedIntent === 'IMPLEMENTATION' || resolvedIntent === 'OWNER_AUTOPILOT') {
    return runImplementationWorkflow({ task, config, slack, store, jobId, logStep, signal });
  }

  if (resolvedIntent === 'INFORMATIONAL') {
    return runInformationalWorkflow({ task, config, slack, logStep, signal });
  }

  if (resolvedIntent === 'CONVERSATIONAL') {
    return runConversationalWorkflow({ task, config, slack, logStep });
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
  const cwd = config.repoPaths.newtonWeb;

  await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `Running workflow: ${template.name}`,
    })
    .catch(() => {});

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

  await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: summary,
    })
    .catch(() => {});

  return {
    workflow: 'IMPLEMENTATION',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    message: summary,
    notifyDesktop: false,
    slackPosted: true,
    result: result.parsedJson ?? {},
  };
}
