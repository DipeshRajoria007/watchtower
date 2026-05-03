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
import { runCodex, getActiveBackendId, selectBackendForUser } from '../codex/runCodex.js';
import { assembleRecall } from '../codex/recallAssembler.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { githubAuthModeHint } from '../github/githubAuth.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { getBackend } from '../backends/registry.js';
import { runAgentPipeline, formatPlanMessage, waitForApproval, buildApprovalMessage } from '../agents/pipeline.js';
import { resolveRepoOrAsk } from './shared/repoResolver.js';
import { waitForClarificationWithIdle, detectClarificationLoop } from './shared/clarificationGuards.js';
import type { ClarificationRound } from './shared/clarificationGuards.js';
import { profileForAgentRole } from '../codex/modelProfiles.js';
import { buildPlannerPrompt } from '../agents/prompts.js';
import { resolveWorkspace } from '../workspaces/workspaceManager.js';
import { createPrFromWorkspace } from '../github/postPipelinePr.js';
import { fetchUnresolvedReviewThreadCount } from '../github/prReviewComments.js';
import type { PipelineStore } from '../agents/pipeline.js';
import type { AgentStepResult, PipelineConfig } from '../agents/types.js';
import type { InvestigationStore } from '../state/investigationStore.js';
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
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION', toneMode: task.toneMode })}

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
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION', toneMode: task.toneMode })}

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
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION', toneMode: task.toneMode })}

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
  store?: PipelineStore & {
    dossierStore?: () => import('../state/dossierStore.js').DossierStore;
    readVaultSettings?: () => { vaultPath: string; vaultEnabled: boolean };
    recentSignalsForUser?: (
      userId: string,
      limit?: number,
    ) => Array<{
      intent: string | null;
      workflow: string | null;
      status: string | null;
      repo: string | null;
      errorKind: string | null;
      createdAt: string;
    }>;
  };
  investigationStore?: InvestigationStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, investigationStore, jobId, logStep, signal } = params;

  logStep?.({
    stage: 'implementation.start',
    message: 'Running implementation workflow.',
  });

  const ctx = await prepareWorkflowContext({ task, config, slack, store, logStep });

  // Thread-scoped investigation findings: if a prior INVESTIGATION ran in
  // this same thread, seed the planner with its diagnosis so vague follow-up
  // messages like "yes fix it" land on a concrete plan instead of re-asking.
  const priorFindings = investigationStore?.getForThread(task.event.threadTs);
  if (priorFindings) {
    const seed = [
      '',
      '=== PRIOR INVESTIGATION FINDINGS FOR THIS THREAD ===',
      `(from job ${priorFindings.jobId}, saved ${priorFindings.createdAt})`,
      priorFindings.summary ? `Summary: ${priorFindings.summary}` : '',
      `Full findings (JSON): ${priorFindings.findingsJson}`,
      '=== END PRIOR FINDINGS ===',
      '',
      'Use these findings as your primary context. The user has already seen them and is now asking you to act — produce a concrete file-level plan. Only ask for clarification if the findings leave a genuine gap.',
    ]
      .filter(Boolean)
      .join('\n');
    ctx.threadContext = `${ctx.threadContext}${seed}`;
    logStep?.({
      stage: 'implementation.investigation_seed',
      message: 'Seeded planner context with prior investigation findings for this thread.',
      data: { investigationJobId: priorFindings.jobId, savedAt: priorFindings.createdAt },
    });
  }

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

    const plannerBackend = store?.dossierStore
      ? selectBackendForUser({
          userId: task.event.userId,
          workflow: 'IMPLEMENTATION',
          dossierStore: store.dossierStore(),
          onSelect: info =>
            logStep?.({
              stage: 'pipeline.backend.select',
              message: `Selected backend ${info.backend} (${info.reason}).`,
              data: info,
            }),
        })
      : getActiveBackendId();
    const plannerProfile = profileForAgentRole('planner', plannerBackend);
    let plannerPrompt = buildPlannerPrompt(plannerCtx);
    if (store?.dossierStore && store.recentSignalsForUser && task.event.userId) {
      try {
        const recall = await assembleRecall({
          userId: task.event.userId,
          workflow: 'IMPLEMENTATION',
          store: store as unknown as import('../state/jobStore.js').JobStore,
          vaultRoot: store.readVaultSettings?.().vaultPath ?? null,
        });
        if (recall.promptBlock) {
          plannerPrompt = `${recall.promptBlock}\n\n${plannerPrompt}`;
          logStep?.({
            stage: 'pipeline.recall.injected',
            message: `Injected recall block (${recall.estimatedTokens} tokens, sources: ${recall.sources.join(', ')})`,
            data: { sources: recall.sources, estimatedTokens: recall.estimatedTokens },
          });
        }
      } catch (err) {
        logStep?.({
          stage: 'pipeline.recall.failed',
          level: 'WARN',
          message: 'Failed to assemble recall block; running without it.',
          data: { error: (err as Error).message },
        });
      }
    }
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

    // Planner-clarification loop: unbounded — keeps asking until the planner
    // produces a concrete plan (no clarificationNeeded), the user goes silent
    // (idle timeout → PAUSED), the user cancels, or we detect a repetition
    // loop (same question twice, or unhelpful short answers back-to-back).
    const clarificationHistory: ClarificationRound[] = [];
    let clarificationRound = 0;
    while (
      typeof plannerOutput.clarificationNeeded === 'string' &&
      plannerOutput.clarificationNeeded.trim().length > 0
    ) {
      clarificationRound++;
      const question = String(plannerOutput.clarificationNeeded).trim();

      const loopCheck = detectClarificationLoop(clarificationHistory, question);
      if (loopCheck.looping) {
        logStep?.({
          stage: 'implementation.planner.clarification.loop_detected',
          message: `Repetition detected after ${clarificationRound - 1} rounds: ${loopCheck.reason} Proceeding with best-guess plan.`,
          level: 'WARN',
          data: { reason: loopCheck.reason, rounds: clarificationRound - 1 },
        });
        try {
          await slack.chat.postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: "I've asked this a couple of times — let me proceed with my best guess and flag my assumptions. Reply here if I got it wrong.",
          });
        } catch {
          // best-effort
        }
        break;
      }

      logStep?.({
        stage: 'implementation.planner.clarification.asking',
        message: `Planner needs clarification (round ${clarificationRound}): ${question}`,
        data: { question, round: clarificationRound },
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
      const outcome = await waitForClarificationWithIdle({
        slack,
        channelId: task.event.channelId,
        threadTs: task.event.threadTs,
        allowedUserIds: allowedAnswerers,
        promptTs: clarificationTs,
        logStep: logStep ?? (() => {}),
        botUserId: config.botUserId,
        nudgeText: "Still waiting on that clarification to build the plan. Reply here or say 'cancel' to stop.",
      });

      if (outcome.outcome === 'cancelled') {
        try {
          await slack.chat.postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: 'Got it, cancelling.',
          });
        } catch {
          // best-effort
        }
        return {
          workflow: 'IMPLEMENTATION',
          status: 'CANCELLED',
          message: 'User cancelled during planner clarification.',
          notifyDesktop: false,
          slackPosted: true,
        };
      }
      if (outcome.outcome === 'timeout') {
        return {
          workflow: 'IMPLEMENTATION',
          status: 'PAUSED',
          message: 'No reply within the idle window — paused. Reply in the thread to resume.',
          notifyDesktop: false,
          slackPosted: true,
        };
      }

      const answer = outcome.answer;
      clarificationHistory.push({ question, answer });

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
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION', toneMode: task.toneMode })}

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

      const quickBackend = store?.dossierStore
        ? selectBackendForUser({
            userId: task.event.userId,
            workflow: 'IMPLEMENTATION',
            dossierStore: store.dossierStore(),
            onSelect: info =>
              logStep?.({
                stage: 'pipeline.backend.select',
                message: `Selected backend ${info.backend} (${info.reason}).`,
                data: info,
              }),
          })
        : getActiveBackendId();
      const quickResult = await runCodex({
        cwd: ctx.cwd,
        prompt: quickPrompt,
        githubToken: ctx.githubToken,
        ...highReasoningProfile(quickBackend),
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

    // Resolve workspace for the coder agent. Single entry point:
    // resolveRepoOrAsk cascades through file hints → text mentions → extension
    // heuristics → classifier → admin clarification (with 6h idle timeout).
    // On timeout or no admins, falls through to desktop_only. On admin cancel
    // we abandon cleanly.
    let pipelineCwd = ctx.cwd;
    if (ctx.isOwnerAuthor) {
      let repoAffinity: { newtonWebHits?: number; newtonApiHits?: number } | undefined;
      if (store?.dossierStore && task.event.userId) {
        try {
          const dossier = store.dossierStore().getDossier(task.event.userId);
          const web = dossier.affinity.find(a => a.repo === 'newton-web');
          const api = dossier.affinity.find(a => a.repo === 'newton-api');
          if (web || api) {
            repoAffinity = { newtonWebHits: web?.hits, newtonApiHits: api?.hits };
          }
        } catch {
          // dossier read shouldn't block repo resolution
        }
      }
      const resolution = await resolveRepoOrAsk({
        task,
        config,
        slack,
        logStep,
        planAffectedFiles,
        threadMessages: ctx.threadMessages,
        repoAffinity,
      });

      if (resolution.outcome === 'cancelled') {
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: 'Cancelled — no repo selected.',
          })
          .catch(() => {});
        return {
          workflow: 'IMPLEMENTATION',
          status: 'CANCELLED',
          message: 'Cancelled during repo-selection clarification.',
          notifyDesktop: false,
          slackPosted: true,
        };
      }

      if (resolution.outcome === 'desktop_only') {
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: `I couldn't pin down which repo this is for (${resolution.reason}) — handing this over to the desktop queue for a human to pick up.`,
          })
          .catch(() => {});
        return {
          workflow: 'IMPLEMENTATION',
          status: 'PAUSED',
          message: `Routed to desktop (${resolution.reason}).`,
          notifyDesktop: true,
          slackPosted: true,
        };
      }

      pipelineCwd = resolveWorkspace(resolution.path, task.event.threadTs);
      logStep?.({
        stage: 'implementation.workspace.resolved',
        message: 'Resolved implementation workspace to isolated worktree.',
        data: { targetRepoPath: resolution.path, repoName: resolution.name, source: resolution.source, pipelineCwd },
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

    const buildPipelineCtx = (threadContextOverride: string) => ({
      workflowIntent: 'IMPLEMENTATION' as const,
      task,
      config,
      repoPath: pipelineCwd,
      githubToken: ctx.githubToken,
      threadContext: threadContextOverride,
      previousSteps: [plannerStep],
      pipelineConfig: fullPipelineConfig,
      imagePaths: ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
      requestedBy: ctx.requestedBy,
    });

    let currentThreadContext = ctx.threadContext;
    let fullResult = await runAgentPipeline({
      ctx: buildPipelineCtx(currentThreadContext),
      slack,
      logStep: logStep ?? (() => {}),
      introMessage: introMsg,
      store,
      jobId,
    });

    const MAX_NEEDS_INPUT_RESUMES = 3;
    let needsInputResumes = 0;
    while (fullResult.finalStatus === 'needs-input' && needsInputResumes < MAX_NEEDS_INPUT_RESUMES) {
      needsInputResumes++;
      const question = fullResult.needsInputQuestion ?? 'I need more information to proceed — could you share details?';

      const askResp = await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: question,
      });
      const promptTs = askResp.ts;

      const adminUserIds = getAdminUserIds(config);
      const allowedIds = Array.from(new Set([task.event.userId, ...adminUserIds, ...config.coreDevSlackUserIds]));

      if (!promptTs) {
        logStep?.({
          stage: 'implementation.needs_input.post_failed',
          message: 'Could not post the needs-input question to Slack — treating as paused.',
          level: 'WARN',
        });
        return {
          workflow: 'IMPLEMENTATION',
          status: 'PAUSED',
          message: 'Paused pending more information (Slack post failed).',
          notifyDesktop: false,
          slackPosted: false,
        };
      }

      const clarification = await waitForClarificationWithIdle({
        slack,
        channelId: task.event.channelId,
        threadTs: task.event.threadTs,
        allowedUserIds: allowedIds,
        promptTs,
        logStep: logStep ?? (() => {}),
        botUserId: config.botUserId,
        nudgeText:
          "Still waiting on more info for the fix — reply here with the error text, failing request, or file scope. Say 'cancel' to stop.",
      });

      if (clarification.outcome === 'cancelled') {
        await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: 'Got it, cancelling.',
        });
        return {
          workflow: 'IMPLEMENTATION',
          status: 'CANCELLED',
          message: 'User cancelled after needs-input prompt.',
          notifyDesktop: false,
          slackPosted: true,
        };
      }

      if (clarification.outcome === 'timeout') {
        return {
          workflow: 'IMPLEMENTATION',
          status: 'PAUSED',
          message: 'No reply within the idle window — paused. Reply in the thread to resume.',
          notifyDesktop: false,
          slackPosted: true,
        };
      }

      currentThreadContext =
        `${currentThreadContext}\n\n<@${clarification.answererId}> follow-up answer: ${clarification.answer}`.trim();

      logStep?.({
        stage: 'implementation.needs_input.resuming',
        message: `Resuming pipeline with follow-up context (attempt ${needsInputResumes}/${MAX_NEEDS_INPUT_RESUMES}).`,
      });

      fullResult = await runAgentPipeline({
        ctx: buildPipelineCtx(currentThreadContext),
        slack,
        logStep: logStep ?? (() => {}),
        introMessage: 'Picking back up with the new info you shared.',
        store,
        jobId,
      });
    }

    if (fullResult.finalStatus === 'needs-input') {
      logStep?.({
        stage: 'implementation.needs_input.exhausted',
        message: `Hit resume cap (${MAX_NEEDS_INPUT_RESUMES}) without enough info — pausing.`,
        level: 'WARN',
      });
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: "I've asked a few times but still don't have enough to write a targeted fix — pausing. Reply with concrete details and I'll resume.",
      });
      return {
        workflow: 'IMPLEMENTATION',
        status: 'PAUSED',
        message: 'Exhausted clarification attempts without enough info to proceed.',
        notifyDesktop: false,
        slackPosted: true,
      };
    }

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
