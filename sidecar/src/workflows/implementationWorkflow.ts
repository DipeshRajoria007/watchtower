import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  NormalizedTask,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import { getAdminUserIds } from '../access/control.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { githubAuthModeHint } from '../github/githubAuth.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { classifyRepo } from '../router/repoClassifier.js';
import { getBackend } from '../backends/registry.js';
import {
  runAgentPipeline,
  formatPlanMessage,
  waitForApproval,
  waitForRepoChoice,
  waitForClarification,
  buildApprovalMessage,
} from '../agents/pipeline.js';
import { profileForAgentRole } from '../codex/modelProfiles.js';
import { buildPlannerPrompt } from '../agents/prompts.js';
import { resolveWorkspace } from '../workspaces/workspaceManager.js';
import { createPrFromWorkspace } from '../github/postPipelinePr.js';
import { fetchUnresolvedReviewThreadCount } from '../github/prReviewComments.js';
import type { PipelineStore } from '../agents/pipeline.js';
import type { AgentStepResult, PipelineConfig } from '../agents/types.js';
import { prepareWorkflowContext, sanitizeOwnerSummary, extractReplyFromCodexResult } from './shared/workflowUtils.js';

function buildOwnerPrimaryPrompt(params: {
  task: NormalizedTask;
  config: AppConfig;
  workspaceRoot: string;
  githubToken?: string;
  threadContext: string;
  imageContext: string;
}): string {
  const { task, workspaceRoot, githubToken, threadContext, imageContext } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION' })}

You are running Watchtower implementation mode.

The request below was sent by a configured owner Slack user.

Environment:
- Working directory: ${workspaceRoot}
- Known repositories: newton-web, newton-api
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

Guardrails:
- Operate only inside the working directory above. Do NOT \`cd\` to any other path.
- If the working directory is not the right repo for this task, return { "status": "failed", "summary": "wrong-repo-assigned: <explanation>" } instead of switching directories.

Task:
Execute the implementation request end-to-end within the working directory. Infer intent from thread context and execute directly.

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
  const { task, workspaceRoot, githubToken, threadContext, imageContext } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION' })}

You are running Watchtower implementation mode in relaxed output mode.

Environment:
- Working directory: ${workspaceRoot}
- Known repositories: newton-web, newton-api
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

Guardrails:
- Operate only inside the working directory above. Do NOT \`cd\` to any other path.

Task:
Execute the implementation request end-to-end within the working directory.

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

/**
 * Pick the target repo path for owner IMPLEMENTATION tasks. Tries (in order):
 *   1. Planner's `affectedFiles` containing an explicit repo name.
 *   2. Explicit mention of "newton-api" / "newton-web" in user/thread text.
 *   3. File-extension hint (`.py` → api, `.tsx/.jsx` → web).
 *   4. Keyword classifier with high confidence.
 *   5. **Ask admins in-thread** (via waitForRepoChoice) — no silent default.
 *
 * Returns the resolved repo path, or `undefined` if the admin cancelled.
 */
async function resolveTargetRepoPath(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  planAffectedFiles: string[];
  threadMessages: Array<{ text: string }>;
}): Promise<string | undefined> {
  const { task, config, slack, logStep, planAffectedFiles, threadMessages } = params;

  const hasWebFiles = planAffectedFiles.some(f => f.includes('newton-web'));
  const hasApiFiles = planAffectedFiles.some(f => f.includes('newton-api'));

  if (hasWebFiles && !hasApiFiles) return config.repoPaths.newtonWeb;
  if (hasApiFiles && !hasWebFiles) return config.repoPaths.newtonApi;

  const combinedText = [task.event.text, ...threadMessages.map(m => m.text)].join('\n');
  const mentionsApi = /\bnewton[-_\s]?api\b/i.test(combinedText);
  const mentionsWeb = /\bnewton[-_\s]?web\b/i.test(combinedText);
  if (mentionsApi && !mentionsWeb) return config.repoPaths.newtonApi;
  if (mentionsWeb && !mentionsApi) return config.repoPaths.newtonWeb;

  if (planAffectedFiles.length > 0) {
    const hasPy = planAffectedFiles.some(f => /\.py$/i.test(f));
    const hasJsx = planAffectedFiles.some(f => /\.(tsx|jsx)$/i.test(f));
    if (hasPy && !hasJsx) return config.repoPaths.newtonApi;
    if (hasJsx && !hasPy) return config.repoPaths.newtonWeb;
  }

  const classification = classifyRepo(
    [task.event.text, ...threadMessages.map(m => m.text)],
    config.repoClassifierThreshold,
  );
  if (!classification.uncertain && classification.selectedRepo) {
    return classification.selectedRepo === 'newton-web' ? config.repoPaths.newtonWeb : config.repoPaths.newtonApi;
  }

  // All heuristics failed — ask admins instead of silently defaulting.
  logStep?.({
    stage: 'implementation.workspace.clarify',
    message: 'Target repo is ambiguous — asking admins to clarify.',
    level: 'WARN',
  });

  const adminUserIds = getAdminUserIds(config);
  const mentionStr = adminUserIds.map(id => `<@${id}>`).join(' ');
  const promptText = `I can't tell whether this task is for *newton-web* or *newton-api*.${mentionStr ? ` ${mentionStr}` : ''} Reply with "web" or "api" (or "cancel" to abandon).`;

  let promptTs: string | undefined;
  try {
    const postResult = await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: promptText,
    });
    promptTs = postResult.ts ?? undefined;
  } catch {
    // Slack post failed — fail closed.
    return undefined;
  }

  if (!promptTs || adminUserIds.length === 0) {
    return undefined;
  }

  const choice = await waitForRepoChoice({
    slack,
    channelId: task.event.channelId,
    threadTs: task.event.threadTs,
    approverUserIds: adminUserIds,
    promptTs,
    logStep: logStep ?? (() => {}),
    botUserId: config.botUserId,
  });

  if (choice.outcome === 'cancelled') {
    return undefined;
  }
  return choice.outcome === 'newton-web' ? config.repoPaths.newtonWeb : config.repoPaths.newtonApi;
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

    // Planner runs directly via runCodex to capture sessionId for iterative feedback
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

    const plannerCtx = {
      workflowIntent: 'IMPLEMENTATION' as const,
      task,
      config,
      repoPath: ctx.cwd,
      githubToken: ctx.githubToken,
      threadContext: ctx.threadContext,
      previousSteps: [] as AgentStepResult[],
      pipelineConfig: plannerPipelineConfig,
      imagePaths: ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
      requestedBy: ctx.requestedBy,
    };

    const plannerProfile = profileForAgentRole('planner', getActiveBackendId());
    const plannerPrompt = buildPlannerPrompt(plannerCtx);
    const plannerSchemaPath = path.resolve(process.cwd(), 'schemas/agent-planner-result.schema.json');

    logStep?.({ stage: 'pipeline.agent.planner.start', message: 'Starting planner agent.' });

    let plannerRunResult = await runCodex({
      cwd: ctx.cwd,
      prompt: plannerPrompt,
      outputSchemaPath: plannerSchemaPath,
      githubToken: ctx.githubToken,
      ...plannerProfile,
      timeoutMs: Math.floor(workflowTimeoutMs * 0.15),
      onLog: logStep,
    });

    let plannerSessionId = plannerRunResult.sessionId;
    let plannerOutput: Record<string, unknown> = plannerRunResult.parsedJson ?? {};

    // Planner-clarification loop: if the planner asks a clarifying question,
    // surface it in Slack, wait for the requester OR an admin to answer, then
    // re-run the planner with the answer as extra context. Up to 3 rounds.
    const MAX_CLARIFICATION_ROUNDS = 3;
    let clarificationRounds = 0;
    while (
      typeof plannerOutput.clarificationNeeded === 'string' &&
      plannerOutput.clarificationNeeded.trim().length > 0 &&
      clarificationRounds < MAX_CLARIFICATION_ROUNDS
    ) {
      clarificationRounds++;
      const question = String(plannerOutput.clarificationNeeded).trim();

      logStep?.({
        stage: 'implementation.planner.clarification.asking',
        message: `Planner needs clarification (round ${clarificationRounds}): ${question}`,
        data: { question, round: clarificationRounds },
      });

      let clarificationTs: string | undefined;
      try {
        const posted = await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: `Quick question before I plan this out: ${question}`,
        });
        clarificationTs = posted.ts ?? undefined;
      } catch {
        break;
      }
      if (!clarificationTs) break;

      const allowedAnswerers = [...new Set([task.event.userId, ...getAdminUserIds(config)])];
      const { answer } = await waitForClarification({
        slack,
        channelId: task.event.channelId,
        threadTs: task.event.threadTs,
        allowedUserIds: allowedAnswerers,
        promptTs: clarificationTs,
        logStep: logStep ?? (() => {}),
        botUserId: config.botUserId,
      });

      const followUpPrompt = plannerSessionId
        ? `The user answered your clarifying question ("${question}") with:\n\n"${answer}"\n\nNow produce the final plan. Return the same JSON schema with \`clarificationNeeded\` set to null.`
        : `You previously asked: "${question}"\nThe user answered: "${answer}"\n\nOriginal plan so far:\n${JSON.stringify(plannerOutput, null, 2)}\n\nNow produce the final plan. Return the same JSON schema with \`clarificationNeeded\` set to null.`;

      plannerRunResult = await runCodex({
        cwd: ctx.cwd,
        prompt: followUpPrompt,
        ...(plannerSessionId ? { resumeSessionId: plannerSessionId } : {}),
        outputSchemaPath: plannerSchemaPath,
        githubToken: ctx.githubToken,
        ...plannerProfile,
        timeoutMs: Math.floor(workflowTimeoutMs * 0.15),
        onLog: logStep,
      });
      plannerSessionId = plannerRunResult.sessionId ?? plannerSessionId;
      if (plannerRunResult.ok && plannerRunResult.parsedJson) {
        plannerOutput = plannerRunResult.parsedJson;
      } else {
        break;
      }
    }

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

      // For merge requests: check for unresolved review comments before proceeding
      const mergeIntent = /\bmerge\b/i.test(task.event.text);
      if (mergeIntent && task.prContext && ctx.githubToken) {
        const adminUserIds = getAdminUserIds(config);
        const { unresolvedCount } = await fetchUnresolvedReviewThreadCount({
          owner: task.prContext.owner,
          repo: task.prContext.repo,
          pullNumber: task.prContext.number,
          githubToken: ctx.githubToken,
        });

        if (unresolvedCount > 0) {
          const confirmMsg = `This PR has ${unresolvedCount} unresolved review comment${unresolvedCount > 1 ? 's' : ''}. Should I still merge? Reply *yes* to proceed or *no* to cancel.`;
          const confirmResult = await slack.chat.postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: confirmMsg,
          });

          if (confirmResult.ts) {
            const approval = await waitForApproval({
              slack,
              channelId: task.event.channelId,
              threadTs: task.event.threadTs,
              approverUserIds: adminUserIds,
              triggerUserId: task.event.userId,
              approvalPromptTs: confirmResult.ts,
              logStep: logStep ?? (() => {}),
              botUserId: config.botUserId,
            });

            if (approval.outcome === 'rejected') {
              await slack.chat
                .postMessage({
                  channel: task.event.channelId,
                  thread_ts: task.event.threadTs,
                  text: 'Got it, skipping the merge.',
                })
                .catch(() => {});

              return {
                workflow: 'IMPLEMENTATION',
                status: 'SKIPPED',
                message: 'Merge cancelled — unresolved review comments.',
                notifyDesktop: false,
                slackPosted: true,
              };
            }
          }
        }
      }

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
    let planSteps = Array.isArray(plannerOutput.plan) ? plannerOutput.plan.map(String) : [];
    let planAffectedFiles = Array.isArray(plannerOutput.affectedFiles) ? plannerOutput.affectedFiles.map(String) : [];
    let planScope = typeof plannerOutput.scope === 'string' ? plannerOutput.scope : 'unknown';

    // Resolve workspace for the coder agent
    let pipelineCwd = ctx.cwd;
    if (ctx.isOwnerAuthor) {
      const targetRepoPath = await resolveTargetRepoPath({
        task,
        config,
        slack,
        logStep,
        planAffectedFiles,
        threadMessages: ctx.threadMessages,
      });

      if (!targetRepoPath) {
        // The admin replied "cancel" (or equivalent) during the clarification
        // gate. Abandon the task cleanly — we have no repo to work in.
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: 'Cancelled — no repo selected.',
          })
          .catch(() => {});
        return {
          workflow: 'IMPLEMENTATION',
          status: 'SKIPPED',
          message: 'Cancelled during repo-selection clarification.',
          notifyDesktop: false,
          slackPosted: true,
        };
      }

      pipelineCwd = resolveWorkspace(targetRepoPath, task.event.threadTs);
      logStep?.({
        stage: 'implementation.workspace.resolved',
        message: 'Resolved implementation workspace to isolated worktree.',
        data: { targetRepoPath, pipelineCwd },
      });
    }

    // Post initial plan
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

    // Iterative approval loop
    const adminUserIds = getAdminUserIds(config);
    const MAX_FEEDBACK_ITERATIONS = 5;
    let feedbackRounds = 0;
    let approved = false;

    if (planMessageTs) {
      for (let iteration = 0; iteration < MAX_FEEDBACK_ITERATIONS; iteration++) {
        const promptText =
          iteration === 0
            ? 'Here\'s my plan. An admin needs to approve before I proceed:\n\u2022 "yes" or "go" \u2014 I\'ll start coding\n\u2022 "no" or "stop" \u2014 I\'ll cancel\n\u2022 Or reply with changes you\'d like and I\'ll adjust'
            : 'Here\'s the revised plan. "yes" to proceed, "no" to cancel, or reply with more changes.';

        let approvalPromptTs: string | undefined;
        try {
          const promptResult = await slack.chat.postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: promptText,
          });
          approvalPromptTs = promptResult.ts ?? undefined;
        } catch {
          // Non-fatal
        }

        if (!approvalPromptTs) break;

        logStep?.({
          stage: 'implementation.approval.waiting',
          message: `Waiting for admin approval of plan (iteration ${iteration + 1}).`,
        });

        const approval = await waitForApproval({
          slack,
          channelId: task.event.channelId,
          threadTs: task.event.threadTs,
          approverUserIds: adminUserIds,
          triggerUserId: task.event.userId,
          approvalPromptTs,
          logStep: logStep ?? (() => {}),
          botUserId: config.botUserId,
        });

        if (approval.outcome === 'approved') {
          approved = true;
          break;
        }

        if (approval.outcome === 'rejected') {
          // Ask if they want to revise before cancelling
          let askReviseTs: string | undefined;
          try {
            const askResult = await slack.chat.postMessage({
              channel: task.event.channelId,
              thread_ts: task.event.threadTs,
              text: 'Got it. Would you like to change the task or the approach? Reply with what you\'d like different, or say "cancel" to stop.',
            });
            askReviseTs = askResult.ts ?? undefined;
          } catch {
            // Non-fatal
          }

          if (!askReviseTs) {
            // Can't post follow-up — cancel
            return {
              workflow: 'IMPLEMENTATION',
              status: 'SKIPPED',
              message: 'Plan rejected by admin.',
              notifyDesktop: false,
              slackPosted: true,
            };
          }

          const followUp = await waitForApproval({
            slack,
            channelId: task.event.channelId,
            threadTs: task.event.threadTs,
            approverUserIds: adminUserIds,
            triggerUserId: task.event.userId,
            approvalPromptTs: askReviseTs,
            logStep: logStep ?? (() => {}),
            botUserId: config.botUserId,
          });

          if (followUp.outcome === 'rejected') {
            await slack.chat
              .postMessage({
                channel: task.event.channelId,
                thread_ts: task.event.threadTs,
                text: 'Understood, cancelling.',
              })
              .catch(() => {});
            return {
              workflow: 'IMPLEMENTATION',
              status: 'SKIPPED',
              message: 'Plan rejected by admin after revision prompt.',
              notifyDesktop: false,
              slackPosted: true,
            };
          }

          if (followUp.outcome === 'approved') {
            approved = true;
            break;
          }

          // followUp.outcome === 'feedback' — fall through to re-plan below
          approval.outcome = 'feedback' as const;
          approval.userReply = followUp.userReply;
        }

        // Feedback path: re-plan using the same session
        if (approval.outcome === 'feedback') {
          feedbackRounds++;
          await slack.chat
            .postMessage({
              channel: task.event.channelId,
              thread_ts: task.event.threadTs,
              text: 'Got your feedback. Revising the plan...',
            })
            .catch(() => {});

          logStep?.({
            stage: 'implementation.approval.revising',
            message: `Revising plan with feedback: "${approval.userReply}"`,
            data: { feedbackRounds },
          });

          const feedbackPrompt = plannerSessionId
            ? `The admin reviewed the plan and provided this feedback:\n\n"${approval.userReply}"\n\nRevise the plan to incorporate this feedback. Return the same JSON schema:\n{\n  "plan": string[],\n  "risks": string[],\n  "affectedFiles": string[],\n  "scope": "small" | "medium" | "large",\n  "requiresCodeChanges": boolean\n}`
            : `You previously produced this plan:\n${JSON.stringify(plannerOutput, null, 2)}\n\nThe admin reviewed it and provided this feedback:\n\n"${approval.userReply}"\n\nRevise the plan to incorporate this feedback. Return the same JSON schema:\n{\n  "plan": string[],\n  "risks": string[],\n  "affectedFiles": string[],\n  "scope": "small" | "medium" | "large",\n  "requiresCodeChanges": boolean\n}`;

          const revisedResult = await runCodex({
            cwd: ctx.cwd,
            prompt: feedbackPrompt,
            ...(plannerSessionId ? { resumeSessionId: plannerSessionId } : {}),
            outputSchemaPath: plannerSchemaPath,
            githubToken: ctx.githubToken,
            ...plannerProfile,
            timeoutMs: Math.floor(workflowTimeoutMs * 0.15),
            onLog: logStep,
          });

          plannerSessionId = revisedResult.sessionId ?? plannerSessionId;

          if (revisedResult.ok && revisedResult.parsedJson) {
            plannerOutput = revisedResult.parsedJson;
            planSteps = Array.isArray(plannerOutput.plan) ? plannerOutput.plan.map(String) : planSteps;
            planAffectedFiles = Array.isArray(plannerOutput.affectedFiles)
              ? plannerOutput.affectedFiles.map(String)
              : planAffectedFiles;
            planScope = typeof plannerOutput.scope === 'string' ? plannerOutput.scope : planScope;
          }

          // Update the plan message in-place
          if (planMessageTs) {
            await slack.chat
              .update({
                channel: task.event.channelId,
                ts: planMessageTs,
                text: formatPlanMessage(planSteps, planAffectedFiles, planScope, undefined, pipelineCwd),
              })
              .catch(() => {});
          }
          // Loop back to post revised approval prompt
        }
      }

      if (!approved) {
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: `Reached the revision limit (${MAX_FEEDBACK_ITERATIONS}). Cancelling \u2014 feel free to start a new request.`,
          })
          .catch(() => {});
        return {
          workflow: 'IMPLEMENTATION',
          status: 'SKIPPED',
          message: 'Exceeded maximum feedback iterations.',
          notifyDesktop: false,
          slackPosted: true,
        };
      }
    }

    // Build the plannerStep for downstream consumption
    const plannerStep: AgentStepResult = {
      role: 'planner',
      status: 'passed',
      output: plannerOutput,
      findings: [],
      durationMs: plannerRunResult.durationMs,
    };

    const introMsg = buildApprovalMessage(feedbackRounds, planSteps.length);

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
        previousSteps: [plannerStep],
        pipelineConfig: fullPipelineConfig,
        imagePaths: ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
        requestedBy: ctx.requestedBy,
      },
      slack,
      logStep: logStep ?? (() => {}),
      introMessage: introMsg,
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
          channelId: task.event.channelId,
          workflow: 'IMPLEMENTATION',
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
