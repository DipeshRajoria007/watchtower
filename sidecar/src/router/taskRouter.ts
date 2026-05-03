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
import { evaluateAccess, getConfiguredAccessControl, resolveRequiredAccessLevel } from '../access/control.js';
import type { JobStore } from '../state/jobStore.js';
import { runDevAssistWorkflow } from '../workflows/devAssistWorkflow.js';
import { runMiniogDossierWorkflow } from '../workflows/miniogDossierWorkflow.js';
import { runDeployWorkflow } from '../workflows/deployWorkflow.js';
import { runImplementationWorkflow } from '../workflows/implementationWorkflow.js';
import { runInvestigationWorkflow } from '../workflows/investigationWorkflow.js';
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
import { formatDossierForPrompt } from '../state/dossierStore.js';

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
  let resolvedIntent: WorkflowIntent = task.intent;
  let classificationReasoning: string | undefined;

  // Resolve dossier-derived tone once at the router so every downstream
  // workflow that builds a mention system prompt can honor it without
  // each one re-querying the DB.
  let toneMode: ReturnType<typeof store.getPersonalityMode> = 'normal';
  if (task.event.userId) {
    try {
      toneMode = store.getPersonalityMode({
        channelId: task.event.channelId,
        userId: task.event.userId,
      });
    } catch {
      // tone lookup is advisory; default 'normal' on any failure
    }
  }

  // Presence pings: cheap regex check, skip the AI classifier entirely.
  const userMessage = (task.event.text ?? '')
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (task.intent !== 'DEV_ASSIST' && task.intent !== 'DEPLOY' && task.intent !== 'MINIOG_DOSSIER') {
    if (isPresencePing(userMessage)) {
      resolvedIntent = 'CONVERSATIONAL';
    } else {
      // For all other intents, use AI to classify.
      // Pass mentionType so the classifier knows if this is a direct @miniOG mention
      // or an indirect @theOG mention (owner-mention triggers should be filtered for relevance).
      const hasPrUrl = Boolean(task.prContext);
      let userDossierSummary: string | undefined;
      try {
        const dossier = store.dossierStore().getDossier(task.event.userId);
        if (dossier.profile || dossier.affinity.length > 0) {
          userDossierSummary = formatDossierForPrompt(dossier);
        }
      } catch (err) {
        logStep?.({
          stage: 'router.classify.dossier_lookup_failed',
          level: 'WARN',
          message: 'Failed to assemble dossier summary for classifier; continuing without it.',
          data: { error: (err as Error).message },
        });
      }
      const classification = await classifyWorkflowIntent({
        userMessage,
        hasPrUrl,
        mentionType: task.mentionType,
        userDossierSummary,
        logStep,
      });
      classificationReasoning = classification.reasoning;

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

      resolvedIntent = classification.intent;
    }
  }

  const routedTask: NormalizedTask =
    resolvedIntent !== task.intent || toneMode !== task.toneMode ? { ...task, intent: resolvedIntent, toneMode } : task;

  // NONE = classifier determined this is human-to-human conversation, miniOG should stay silent
  if (resolvedIntent === 'NONE') {
    logStep?.({
      stage: 'router.silent',
      message: 'Classifier returned NONE — staying silent for this human-to-human conversation.',
      data: { reasoning: classificationReasoning },
    });
    return {
      workflow: 'NONE',
      status: 'SKIPPED',
      message: 'Staying silent — message is human-to-human conversation.',
      notifyDesktop: false,
      slackPosted: false,
    };
  }

  const accessControl = getConfiguredAccessControl(config);
  const requiredLevel = resolveRequiredAccessLevel(resolvedIntent);
  const accessDecision = evaluateAccess({
    config,
    accessControl,
    userId: task.event.userId,
    channelId: task.event.channelId,
    channelType: task.event.channelType,
    requiredLevel,
  });

  if (!accessDecision.allowed) {
    const isDirectMessage = task.event.channelType === 'im' || task.event.channelType === 'mpim';
    const shouldBlock = accessControl.mode === 'enforce' || isDirectMessage;
    const stage =
      isDirectMessage && accessControl.mode === 'audit'
        ? 'access.dm.denied'
        : accessControl.mode === 'enforce'
          ? 'access.enforce.denied'
          : 'access.audit.would_deny';
    const message =
      isDirectMessage && accessControl.mode === 'audit'
        ? 'DMs and MPIMs are always enforced; blocked despite audit mode.'
        : accessControl.mode === 'enforce'
          ? 'Access control denied this request.'
          : 'Access control would deny this request, but audit mode allowed it to continue.';

    logStep?.({
      stage,
      message,
      level: shouldBlock ? 'INFO' : 'WARN',
      data: {
        intent: resolvedIntent,
        requiredLevel,
        userGroups: accessDecision.userGroups,
        matchedGroups: accessDecision.matchedGroups,
        userId: task.event.userId,
        channelId: task.event.channelId,
        channelType: task.event.channelType,
      },
    });

    if (shouldBlock) {
      const denialText = isDirectMessage
        ? "Sorry about this — you don't currently have access to DM me. Please contact an admin."
        : (accessDecision.reason ?? "Sorry, you're not on the access list for this channel. Please contact an admin.");

      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: denialText,
      });

      return {
        workflow: resolvedIntent,
        status: 'SKIPPED',
        message: denialText,
        notifyDesktop: false,
        slackPosted: true,
      };
    }
  } else {
    logStep?.({
      stage: accessDecision.ownerBypass ? 'access.owner_bypass' : 'access.allowed',
      message: accessDecision.ownerBypass
        ? 'Owner bypass granted unrestricted access.'
        : 'Access control allowed this request.',
      data: {
        intent: resolvedIntent,
        requiredLevel,
        userGroups: accessDecision.userGroups,
        matchedGroups: accessDecision.matchedGroups,
        userId: task.event.userId,
        channelId: task.event.channelId,
      },
    });
  }

  if (resolvedIntent === 'PR_REVIEW') {
    return runPrReviewWorkflow({ task: routedTask, config, slack, store, jobId, logStep, signal });
  }

  if (resolvedIntent === 'IMPLEMENTATION' || resolvedIntent === 'OWNER_AUTOPILOT') {
    return runImplementationWorkflow({
      task: routedTask,
      config,
      slack,
      store,
      investigationStore: store?.investigationStore(),
      jobId,
      logStep,
      signal,
    });
  }

  if (resolvedIntent === 'INVESTIGATION') {
    return runInvestigationWorkflow({
      task: routedTask,
      config,
      slack,
      store,
      investigationStore: store?.investigationStore(),
      jobId,
      logStep,
      signal,
    });
  }

  if (resolvedIntent === 'INFORMATIONAL') {
    return runInformationalWorkflow({ task: routedTask, config, slack, store, logStep, signal });
  }

  if (resolvedIntent === 'CONVERSATIONAL') {
    return runConversationalWorkflow({ task: routedTask, config, slack, logStep });
  }

  if (resolvedIntent === 'DEV_ASSIST') {
    return runDevAssistWorkflow({ task: routedTask, config, slack, store, logStep });
  }

  if (resolvedIntent === 'MINIOG_DOSSIER') {
    return runMiniogDossierWorkflow({ task: routedTask, slack, store, logStep });
  }

  if (resolvedIntent === 'DEPLOY') {
    return runDeployWorkflow({ task: routedTask, config, slack, logStep, signal });
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

      return runTemplateWorkflow({ task: routedTask, config, slack, template: matched, logStep, signal });
    }
  }

  return runUnknownTaskWorkflow({ task: routedTask, config, slack, logStep });
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
