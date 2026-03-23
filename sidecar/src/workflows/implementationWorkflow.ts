import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  NormalizedTask,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { githubAuthModeHint } from '../github/githubAuth.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { classifyRepo } from '../router/repoClassifier.js';
import { getBackend } from '../backends/registry.js';
import { runAgentPipeline, formatPlanMessage, waitForApproval } from '../agents/pipeline.js';
import { resolveWorkspace } from '../workspaces/workspaceManager.js';
import { createPrFromWorkspace } from '../github/postPipelinePr.js';
import type { PipelineStore } from '../agents/pipeline.js';
import type { PipelineConfig } from '../agents/types.js';
import { prepareWorkflowContext, sanitizeOwnerSummary, extractReplyFromCodexResult } from './shared/workflowUtils.js';

function buildOwnerPrimaryPrompt(params: {
  task: NormalizedTask;
  config: AppConfig;
  workspaceRoot: string;
  githubToken?: string;
  threadContext: string;
  imageContext: string;
}): string {
  const { task, config, workspaceRoot, githubToken, threadContext, imageContext } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION' })}

You are running Watchtower implementation mode.

The request below was sent by a configured owner Slack user.

Environment:
- Preferred workspace root: ${workspaceRoot}
- Known repositories: ${config.repoPaths.newtonWeb} and ${config.repoPaths.newtonApi}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

Task:
Execute the implementation request end-to-end. You may choose whichever local repos/files/commands are needed. Infer intent from thread context and execute directly.

Slack thread context:
${threadContext}${imageContext}

Output rules:
Your response will be posted to a Slack thread. The "summary" field is what the user sees directly.

Return strict JSON with:
- status: "success" | "failed"
- summary: a short, clean Slack message describing what you did. This is posted directly to the user — write it as a ready-to-post Slack message. No telemetry, no ceremony, no "Actions performed" lists.
- actions: array of concrete actions performed (for internal logging only, the user does not see this)
- prUrl: PR URL if one was created, else empty string
- confidence: number between 0 and 1
`.trim();
}

function buildOwnerRelaxedPrompt(params: {
  task: NormalizedTask;
  config: AppConfig;
  workspaceRoot: string;
  githubToken?: string;
  threadContext: string;
  imageContext: string;
}): string {
  const { task, config, workspaceRoot, githubToken, threadContext, imageContext } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION' })}

You are running Watchtower implementation mode in relaxed output mode.

Environment:
- Preferred workspace root: ${workspaceRoot}
- Known repositories: ${config.repoPaths.newtonWeb} and ${config.repoPaths.newtonApi}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

Task:
Execute the implementation request end-to-end. Use whichever local repos/files/commands are needed.

Slack thread context:
${threadContext}${imageContext}

Your response will be posted DIRECTLY to a Slack thread as-is. Write a ready-to-post Slack message:
- One concise response describing what you did.
- Plain text only (not JSON).
- Use Slack markdown if needed (*bold*, \`code\`).
`.trim();
}

function buildGuardrailedPrompt(params: {
  task: NormalizedTask;
  repoPath: string;
  repoName: string;
  githubToken?: string;
  threadContext: string;
  imageContext: string;
}): string {
  const { task, repoPath, repoName, githubToken, threadContext, imageContext } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION' })}

You are running Watchtower implementation mode with repository-scoped guardrails.

Environment:
- Working directory: ${repoPath}
- Repository: ${repoName}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

GUARDRAILS:
- Work only within this repository directory. Do not access or modify files outside of it.
- Do not run destructive git commands (force push, reset --hard, etc.).

Task:
Implement the requested changes within the repository. Create a branch, commit your changes, and open a PR to the default branch.

Slack thread context:
${threadContext}${imageContext}

Output rules:
Your "summary" field will be posted directly to a Slack thread — write it as a ready-to-post message.

Return strict JSON with:
- status: "success" | "failed"
- summary: a short, clean Slack message describing what you did. No telemetry, no ceremony.
- actions: array of concrete actions performed (for internal logging only)
- prUrl: PR URL if one was created, else empty string
- confidence: number between 0 and 1
`.trim();
}

export async function runImplementationWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: PipelineStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, jobId, logStep, signal } = params;

  logStep?.({
    stage: 'implementation.start',
    message: 'Running implementation workflow.',
  });

  const ctx = await prepareWorkflowContext({ task, config, slack, logStep });

  // --- Multi-agent pipeline path ---
  if (config.multiAgentEnabled) {
    logStep?.({
      stage: 'implementation.pipeline.start',
      message: 'Running implementation through multi-agent pipeline.',
      data: { isOwnerAuthor: ctx.isOwnerAuthor },
    });

    // Planner runs to produce plan steps, affected files, and scope
    const workflowTimeoutMs = config.bugFixTimeoutMs;
    const plannerPipelineConfig: PipelineConfig = {
      agents: ['planner'],
      maxRetryLoops: 0,
      abortOnCriticalFinding: false,
      slackProgressUpdates: false,
      requireApproval: false,
      totalTimeoutMs: Math.floor(workflowTimeoutMs * 0.15),
      perAgentTimeoutMs: Math.floor(workflowTimeoutMs * 0.15),
    };

    const plannerResult = await runAgentPipeline({
      ctx: {
        workflowIntent: 'IMPLEMENTATION',
        task,
        config,
        repoPath: ctx.cwd,
        githubToken: ctx.githubToken,
        threadContext: ctx.threadContext,
        previousSteps: [],
        pipelineConfig: plannerPipelineConfig,
        imagePaths: ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
        requestedBy: ctx.requestedBy,
      },
      slack,
      logStep: logStep ?? (() => {}),
      store,
      jobId,
    });

    const plannerStep = plannerResult.steps[0];
    const plannerOutput = plannerStep?.output ?? {};
    const plannerRequiresCodeChanges = Boolean(plannerOutput.requiresCodeChanges);

    // Quick-action fast path: if the planner says no code changes are needed
    // (e.g., "merge this PR", "close PR", "deploy", "run tests"), skip the full
    // pipeline and execute directly with a single codex call. No approval gate needed.
    if (!plannerRequiresCodeChanges) {
      logStep?.({
        stage: 'implementation.quick_action',
        message: 'Planner says no code changes needed — executing as quick action (no approval, no pipeline).',
        data: { plan: plannerOutput.plan },
      });

      const quickPrompt = `
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION' })}

Context:
- You are miniOG, a developer assistant bot in a Slack workspace.
- Your response will be posted DIRECTLY into a Slack thread as-is.
- Working directory: ${ctx.cwd}
- GitHub auth mode: ${githubAuthModeHint(Boolean(ctx.githubToken))}

Task:
Execute this request directly. No code changes are needed — this is a quick operational action (merge PR, deploy, run command, etc.).

Slack thread context:
${ctx.threadContext}${ctx.imageContext}

Write your response as a ready-to-post Slack message describing what you did.
`.trim();

      const quickResult = await runCodex({
        cwd: ctx.cwd,
        prompt: quickPrompt,
        githubToken: ctx.githubToken,
        ...highReasoningProfile(getActiveBackendId()),
        // timeoutMs: Math.floor(workflowTimeoutMs * 0.5),
        onLog: logStep,
        signal,
      });

      const reply = extractReplyFromCodexResult(quickResult) || 'Quick action completed.';

      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: reply,
      });

      return {
        workflow: 'IMPLEMENTATION',
        status: quickResult.ok ? 'SUCCESS' : 'FAILED',
        message: reply,
        notifyDesktop: false,
        slackPosted: true,
      };
    }

    // Full pipeline path: code changes are needed
    const planSteps = Array.isArray(plannerOutput.plan) ? plannerOutput.plan.map(String) : [];
    const planAffectedFiles = Array.isArray(plannerOutput.affectedFiles) ? plannerOutput.affectedFiles.map(String) : [];
    const planScope = typeof plannerOutput.scope === 'string' ? plannerOutput.scope : 'unknown';

    // Resolve workspace for the coder agent
    let pipelineCwd = ctx.cwd;
    if (ctx.isOwnerAuthor) {
      const hasWebFiles = planAffectedFiles.some(f => f.includes('newton-web'));
      const hasApiFiles = planAffectedFiles.some(f => f.includes('newton-api'));
      let targetRepoPath: string | undefined;

      if (hasWebFiles && !hasApiFiles) {
        targetRepoPath = config.repoPaths.newtonWeb;
      } else if (hasApiFiles && !hasWebFiles) {
        targetRepoPath = config.repoPaths.newtonApi;
      } else {
        const texts = [task.event.text, ...ctx.threadMessages.map(m => m.text)];
        const classification = classifyRepo(texts, config.repoClassifierThreshold);
        if (!classification.uncertain && classification.selectedRepo) {
          targetRepoPath =
            classification.selectedRepo === 'newton-web' ? config.repoPaths.newtonWeb : config.repoPaths.newtonApi;
        }
      }

      if (!targetRepoPath) {
        targetRepoPath = config.repoPaths.newtonWeb;
        logStep?.({
          stage: 'implementation.workspace.fallback',
          message: 'Could not determine target repo — defaulting to newton-web.',
          level: 'WARN',
        });
      }

      pipelineCwd = resolveWorkspace(targetRepoPath, task.event.threadTs);
      logStep?.({
        stage: 'implementation.workspace.resolved',
        message: 'Resolved implementation workspace to isolated worktree.',
        data: { targetRepoPath, pipelineCwd },
      });
    }

    let planMessageTs: string | undefined;
    if (planSteps.length > 0) {
      try {
        const planResult = await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: formatPlanMessage(planSteps, planAffectedFiles, planScope, undefined, pipelineCwd),
        });
        planMessageTs = planResult.ts ?? undefined;
      } catch {
        // Non-fatal
      }
    }

    // Approval gate
    if (planMessageTs) {
      let approvalPromptTs: string | undefined;
      try {
        const promptResult = await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: 'Here\'s my plan. Should I go ahead? Reply in this thread:\n• "yes" or "go" — I\'ll start coding\n• "no" or "stop" — I\'ll cancel\n• Or reply with changes you\'d like and I\'ll adjust',
        });
        approvalPromptTs = promptResult.ts ?? undefined;
      } catch {
        // Non-fatal
      }

      if (approvalPromptTs) {
        logStep?.({
          stage: 'implementation.approval.waiting',
          message: 'Waiting for user approval of plan before proceeding.',
        });

        const approval = await waitForApproval({
          slack,
          channelId: task.event.channelId,
          threadTs: task.event.threadTs,
          triggerUserId: task.event.userId,
          approvalPromptTs,
          logStep: logStep ?? (() => {}),
        });

        if (!approval.approved) {
          await slack.chat
            .postMessage({
              channel: task.event.channelId,
              thread_ts: task.event.threadTs,
              text: 'Got it, cancelling.',
            })
            .catch(() => {});

          return {
            workflow: 'IMPLEMENTATION',
            status: 'SKIPPED',
            message: 'Plan rejected by user.',
            notifyDesktop: false,
            slackPosted: true,
          };
        }
      }
    }

    // Run the execution pipeline (coder -> reviewer -> verifier)
    const fullPipelineConfig: PipelineConfig = {
      agents: ['coder', 'reviewer', 'verifier'],
      maxRetryLoops: 2,
      abortOnCriticalFinding: true,
      slackProgressUpdates: true,
      requireApproval: false,
      totalTimeoutMs: workflowTimeoutMs,
      perAgentTimeoutMs: Math.floor(workflowTimeoutMs / 3),
    };

    const fullResult = await runAgentPipeline({
      ctx: {
        workflowIntent: 'IMPLEMENTATION',
        task,
        config,
        repoPath: pipelineCwd,
        githubToken: ctx.githubToken,
        threadContext: ctx.threadContext,
        previousSteps: plannerStep ? [plannerStep] : [],
        pipelineConfig: fullPipelineConfig,
        imagePaths: ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
        requestedBy: ctx.requestedBy,
      },
      slack,
      logStep: logStep ?? (() => {}),
      store,
      jobId,
    });

    const coderStep = fullResult.steps.find(s => s.role === 'coder');
    const rawCoderSummary = coderStep?.output?.summary ? sanitizeOwnerSummary(String(coderStep.output.summary)) : '';
    const summary =
      rawCoderSummary ||
      (fullResult.finalStatus === 'passed'
        ? 'Pipeline completed but the agent did not return a summary. Check the repo for changes.'
        : `Pipeline finished with status: ${fullResult.finalStatus}. The agent did not produce output — it may not be installed or may have timed out.`);

    let prUrl = coderStep?.output?.prUrl ? String(coderStep.output.prUrl) : '';

    if (!prUrl) {
      logStep?.({
        stage: 'implementation.pr.creating',
        message: 'Coder did not produce a PR — creating one from workspace changes.',
      });

      prUrl =
        (await createPrFromWorkspace({
          repoPath: pipelineCwd,
          threadTs: task.event.threadTs,
          summary,
          requestedBy: ctx.requestedBy,
          onLog: msg =>
            logStep?.({
              stage: 'implementation.pr.progress',
              message: msg,
            }),
        })) ?? '';
    }

    const prBlock = prUrl ? `\n${prUrl}` : '';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `${summary}${prBlock}`.trim(),
    });

    const workflowStatus = fullResult.finalStatus === 'passed' || Boolean(prUrl) ? 'SUCCESS' : 'FAILED';

    return {
      workflow: 'IMPLEMENTATION',
      status: workflowStatus,
      message: summary,
      notifyDesktop: false,
      slackPosted: true,
      result: { prUrl },
    };
  }

  // --- Single-agent path (legacy) ---
  const cwd = ctx.cwd;
  const prompt = ctx.isOwnerAuthor
    ? buildOwnerPrimaryPrompt({
        task,
        config,
        workspaceRoot: cwd,
        githubToken: ctx.githubToken,
        threadContext: ctx.threadContext,
        imageContext: ctx.imageContext,
      })
    : buildGuardrailedPrompt({
        task,
        repoPath: cwd,
        repoName: ctx.repoName ?? 'unknown',
        githubToken: ctx.githubToken,
        threadContext: ctx.threadContext,
        imageContext: ctx.imageContext,
      });

  const backend = getBackend(getActiveBackendId());
  const request: CodexRunRequest = {
    cwd,
    prompt,
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/owner-autopilot-result.schema.json'),
    githubToken: ctx.githubToken,
    imagePaths: ctx.imagePaths.length > 0 && backend.supportsImages() ? ctx.imagePaths : undefined,
    ...highReasoningProfile(getActiveBackendId()),
    onLog: logStep,
    signal,
  };

  logStep?.({
    stage: 'implementation.codex.start',
    message: 'Starting implementation Codex execution with high-reasoning profile.',
    data: { cwd, isOwnerAuthor: ctx.isOwnerAuthor },
  });

  const result = await runCodex(request);

  logStep?.({
    stage: 'implementation.codex.finish',
    message: 'Implementation Codex execution finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: { ok: result.ok, timedOut: result.timedOut, exitCode: result.exitCode },
  });

  // Plain text fallback
  const primaryTextFallback =
    result.ok && !result.parsedJson ? sanitizeOwnerSummary(result.lastMessage || result.stdout) : '';

  if (primaryTextFallback) {
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: primaryTextFallback,
    });
    return {
      workflow: 'IMPLEMENTATION',
      status: 'SUCCESS',
      message: primaryTextFallback,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (!result.ok || !result.parsedJson) {
    // Owner relaxed retry
    if (ctx.isOwnerAuthor) {
      const relaxedPrompt = buildOwnerRelaxedPrompt({
        task,
        config,
        workspaceRoot: cwd,
        githubToken: ctx.githubToken,
        threadContext: ctx.threadContext,
        imageContext: ctx.imageContext,
      });
      const relaxedResult = await runCodex({
        cwd,
        prompt: relaxedPrompt,
        githubToken: ctx.githubToken,
        imagePaths: ctx.imagePaths.length > 0 && backend.supportsImages() ? ctx.imagePaths : undefined,
        ...highReasoningProfile(getActiveBackendId()),
        onLog: logStep,
        signal,
      });

      if (relaxedResult.ok) {
        const relaxedSummaryRaw = relaxedResult.lastMessage || relaxedResult.stdout;
        const relaxedSummary = sanitizeOwnerSummary(relaxedSummaryRaw || '');
        const messageText = relaxedSummary || 'Workflow completed but the agent returned empty output.';

        await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: messageText,
        });

        return {
          workflow: 'IMPLEMENTATION',
          status: 'SUCCESS',
          message: messageText,
          notifyDesktop: false,
          slackPosted: true,
        };
      }
    }

    const userFacingMessage =
      'I hit an execution issue right now. Ask me again in a moment, or share the task in one line and I will retry.';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: userFacingMessage,
    });

    notifyDesktop('Watchtower implementation failed', `thread=${task.event.threadTs}`);

    return {
      workflow: 'IMPLEMENTATION',
      status: 'PAUSED',
      message: userFacingMessage,
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  // Parse structured JSON response
  const status = String(result.parsedJson.status ?? 'success') === 'success' ? 'success' : 'failed';
  const summaryRaw = String(result.parsedJson.summary ?? 'Implementation completed.');
  const summary = sanitizeOwnerSummary(summaryRaw);
  const prUrl = String(result.parsedJson.prUrl ?? '');

  const prBlock = prUrl ? `\n${prUrl}` : '';
  const text = `${summary}${prBlock}`.trim();

  if (text) {
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });
  }

  return {
    workflow: 'IMPLEMENTATION',
    status: status === 'failed' ? 'FAILED' : 'SUCCESS',
    message: summary || 'Implementation completed.',
    notifyDesktop: false,
    slackPosted: Boolean(text),
    result: result.parsedJson,
  };
}
