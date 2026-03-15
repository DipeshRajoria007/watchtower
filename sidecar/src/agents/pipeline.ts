import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AgentContext,
  AgentFinding,
  AgentRole,
  AgentStepResult,
  PipelineResult,
} from './types.js';
import type { WorkflowStepLogger } from '../types/contracts.js';
import { buildPromptForRole } from './prompts.js';
import { profileForAgentRole } from '../codex/modelProfiles.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { fetchThreadContext } from '../slack/threadContext.js';

export type PipelineStore = {
  createPipelineRun(input: {
    id: string;
    jobId: string;
    pipelineConfigJson: string;
    status: string;
    stepsJson: string;
    retryLoops?: number;
    totalDurationMs?: number;
  }): void;
  updatePipelineRun(
    id: string,
    updates: {
      status?: string;
      stepsJson?: string;
      retryLoops?: number;
      totalDurationMs?: number;
    },
  ): void;
};

const SCHEMA_MAP: Partial<Record<AgentRole, string>> = {
  planner: 'agent-planner-result.schema.json',
  reviewer: 'agent-reviewer-result.schema.json',
  security: 'agent-security-result.schema.json',
  performance: 'agent-performance-result.schema.json',
  verifier: 'agent-verifier-result.schema.json',
};

function extractFindings(output: Record<string, unknown>): AgentFinding[] {
  const raw = output.findings;
  if (!Array.isArray(raw)) return [];
  return raw.map(f => ({
    severity: f.severity ?? 'info',
    category: f.category ?? 'general',
    message: f.message ?? '',
    file: f.file,
    line: f.line,
    suggestion: f.suggestion,
  }));
}

function hasCriticalFinding(findings: AgentFinding[]): boolean {
  return findings.some(f => f.severity === 'critical');
}

function determineStepStatus(output: Record<string, unknown>, findings: AgentFinding[]): 'passed' | 'failed' {
  if (hasCriticalFinding(findings)) return 'failed';
  if (output.approved === false || output.verified === false) return 'failed';
  return 'passed';
}

const ROLE_START_MESSAGES: Record<AgentRole, string> = {
  planner: 'Thinking through the approach...',
  coder: 'Writing the code now.',
  reviewer: 'Reviewing the changes for quality.',
  security: 'Checking for security issues.',
  performance: 'Checking for performance issues.',
  verifier: 'Running final checks.',
};

function buildCompletionMessage(role: AgentRole, status: string, nextRole?: AgentRole): string {
  if (!nextRole) {
    return role === 'verifier'
      ? 'All checks done. Wrapping up.'
      : 'Done. Wrapping up.';
  }

  const transitions: Record<AgentRole, string> = {
    planner: "Got a plan. Starting the code changes.",
    coder: "Code's done — running it through review.",
    reviewer: status === 'passed'
      ? 'Review looks good. Running final checks.'
      : 'Review flagged some things. Running final checks.',
    security: 'Security check done. Moving on.',
    performance: 'Performance check done. Moving on.',
    verifier: 'All checks done. Wrapping up.',
  };

  return transitions[role];
}

async function postSlackProgress(params: {
  slack: WebClient;
  ctx: AgentContext;
  text: string;
}): Promise<string | undefined> {
  if (!params.ctx.pipelineConfig.slackProgressUpdates) return undefined;
  const { channelId, threadTs } = params.ctx.task.event;
  try {
    const result = await params.slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: params.text,
    });
    return result.ts ?? undefined;
  } catch {
    // Non-fatal: progress update failure should not abort pipeline
    return undefined;
  }
}

async function updateSlackMessage(params: {
  slack: WebClient;
  ctx: AgentContext;
  ts: string;
  text: string;
}): Promise<void> {
  const { channelId } = params.ctx.task.event;
  try {
    await params.slack.chat.update({
      channel: channelId,
      ts: params.ts,
      text: params.text,
    });
  } catch {
    // Non-fatal
  }
}

function stripRepoPrefix(filePath: string, repoPath: string): string {
  if (filePath.startsWith(repoPath)) {
    const relative = filePath.slice(repoPath.length);
    return relative.startsWith('/') ? relative.slice(1) : relative;
  }
  return filePath;
}

function formatPlanMessage(planSteps: string[], affectedFiles: string[], scope: string, completedSteps?: Set<number>, repoPath?: string): string {
  const header = `*Plan* (scope: ${scope}, ${affectedFiles.length} files affected)`;
  const stepLines = planSteps.map((step, i) => {
    const num = `${i + 1}.`;
    if (completedSteps?.has(i)) {
      return `~${num} ${step}~`;
    }
    return `${num} ${step}`;
  });
  const displayFiles = repoPath
    ? affectedFiles.map(f => stripRepoPrefix(f, repoPath))
    : affectedFiles;
  const filesSection = displayFiles.length > 0
    ? `\n\n*Affected files:*\n${displayFiles.map(f => `• \`${f}\``).join('\n')}`
    : '';
  return `${header}\n${stepLines.join('\n')}${filesSection}`;
}

const APPROVE_PATTERNS = /^(yes|go|proceed|do it|go ahead|ship it|lgtm)$/i;
const REJECT_PATTERNS = /^(no|stop|cancel|abort|nevermind|never mind)$/i;

async function waitForApproval(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  triggerUserId: string;
  approvalPromptTs: string;
  logStep: WorkflowStepLogger;
}): Promise<{ approved: boolean; userReply: string }> {
  const { slack, channelId, threadTs, triggerUserId, approvalPromptTs, logStep } = params;
  const pollIntervalMs = 5_000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    let messages: Array<{ text: string; user: string; ts: string }>;
    try {
      messages = await fetchThreadContext(slack, channelId, threadTs);
    } catch {
      // Transient Slack error — retry on next tick
      continue;
    }

    // Find messages from the trigger user that are newer than the approval prompt
    const userReplies = messages.filter(
      m => m.user === triggerUserId && m.ts > approvalPromptTs,
    );

    if (userReplies.length === 0) continue;

    const latestReply = userReplies[userReplies.length - 1];
    const text = latestReply.text.trim();

    if (APPROVE_PATTERNS.test(text)) {
      logStep({
        stage: 'pipeline.approval.approved',
        message: `User approved the plan: "${text}"`,
      });
      return { approved: true, userReply: text };
    }

    if (REJECT_PATTERNS.test(text)) {
      logStep({
        stage: 'pipeline.approval.rejected',
        message: `User rejected the plan: "${text}"`,
      });
      return { approved: false, userReply: text };
    }

    // Anything else is modification feedback — treat as approval with feedback
    // (the caller can append this to context and re-run planner if desired)
    logStep({
      stage: 'pipeline.approval.feedback',
      message: `User provided feedback: "${text}"`,
    });
    return { approved: true, userReply: text };
  }
}

export async function runAgentPipeline(params: {
  ctx: AgentContext;
  slack: WebClient;
  logStep: WorkflowStepLogger;
  store?: PipelineStore;
  jobId?: string;
}): Promise<PipelineResult> {
  const { ctx, slack, logStep, store, jobId } = params;
  const { agents, maxRetryLoops, perAgentTimeoutMs, totalTimeoutMs, abortOnCriticalFinding } = ctx.pipelineConfig;

  const pipelineStart = Date.now();
  const steps: AgentStepResult[] = [];
  let retryLoops = 0;
  let aborted = false;

  const pipelineRunId = randomUUID();
  if (store && jobId) {
    try {
      store.createPipelineRun({
        id: pipelineRunId,
        jobId,
        pipelineConfigJson: JSON.stringify(ctx.pipelineConfig),
        status: 'running',
        stepsJson: '[]',
      });
    } catch {
      // Non-fatal: persistence failure should not block pipeline execution
    }
  }

  logStep({
    stage: 'pipeline.start',
    message: `Starting multi-agent pipeline with ${agents.length} agents.`,
    data: { agents, maxRetryLoops, totalTimeoutMs },
  });

  await postSlackProgress({
    slack,
    ctx,
    text: `On it — planning the approach first, then I'll code it up, get it reviewed, and verify everything works.`,
  });

  // Track plan message so we can update it with strikethroughs during execution
  let planMessageTs: string | undefined;
  let planSteps: string[] = [];
  let planAffectedFiles: string[] = [];
  let planScope = 'unknown';

  for (let i = 0; i < agents.length; i++) {
    if (totalTimeoutMs) {
      const elapsed = Date.now() - pipelineStart;
      if (elapsed >= totalTimeoutMs) {
        logStep({
          stage: 'pipeline.timeout',
          message: 'Pipeline total timeout exceeded.',
          level: 'ERROR',
          data: { elapsed, totalTimeoutMs },
        });
        aborted = true;
        break;
      }
    }

    const role = agents[i];
    const agentStart = Date.now();

    logStep({
      stage: `pipeline.agent.${role}.start`,
      message: `Starting ${role} agent (step ${i + 1}/${agents.length}).`,
    });

    await postSlackProgress({
      slack,
      ctx,
      text: `[${i + 1}/${agents.length}] ${ROLE_START_MESSAGES[role]}`,
    });

    const prompt = buildPromptForRole(role, {
      ...ctx,
      previousSteps: steps,
    });

    const profile = profileForAgentRole(role, getActiveBackendId());
    const schemaFile = SCHEMA_MAP[role];
    const schemaPath = schemaFile
      ? path.resolve(process.cwd(), `schemas/${schemaFile}`)
      : undefined;

    const result = await runCodex({
      cwd: ctx.repoPath,
      prompt,
      outputSchemaPath: schemaPath,
      githubToken: ctx.githubToken,
      ...profile,
      onLog: logStep,
    });

    const durationMs = Date.now() - agentStart;
    const output = result.parsedJson ?? {};
    const findings = extractFindings(output);
    const status = result.ok ? determineStepStatus(output, findings) : 'failed';

    const stepResult: AgentStepResult = {
      role,
      status,
      output,
      findings,
      durationMs,
    };

    steps.push(stepResult);

    logStep({
      stage: `pipeline.agent.${role}.finish`,
      message: `${role} agent finished: ${status} (${durationMs}ms, ${findings.length} findings).`,
      level: status === 'failed' ? 'WARN' : 'INFO',
      data: { status, durationMs, findings: findings.length },
    });

    const nextRole = i < agents.length - 1 ? agents[i + 1] : undefined;
    await postSlackProgress({
      slack,
      ctx,
      text: `[${i + 1}/${agents.length}] ${buildCompletionMessage(role, status, nextRole)}`,
    });

    // After planner completes: post the plan as a formatted message
    if (role === 'planner' && status === 'passed' && output.plan) {
      planSteps = Array.isArray(output.plan) ? output.plan.map(String) : [];
      planAffectedFiles = Array.isArray(output.affectedFiles) ? output.affectedFiles.map(String) : [];
      planScope = typeof output.scope === 'string' ? output.scope : 'unknown';

      if (planSteps.length > 0) {
        planMessageTs = await postSlackProgress({
          slack,
          ctx,
          text: formatPlanMessage(planSteps, planAffectedFiles, planScope, undefined, ctx.repoPath),
        });
      }

      // Approval gate: wait for user to confirm the plan before proceeding
      if (ctx.pipelineConfig.requireApproval && planMessageTs) {
        const approvalPromptTs = await postSlackProgress({
          slack,
          ctx,
          text: "Here's my plan. Should I go ahead? Reply in this thread:\n• \"yes\" or \"go\" — I'll start coding\n• \"no\" or \"stop\" — I'll cancel\n• Or reply with changes you'd like and I'll adjust",
        });

        if (approvalPromptTs) {
          const approval = await waitForApproval({
            slack,
            channelId: ctx.task.event.channelId,
            threadTs: ctx.task.event.threadTs,
            triggerUserId: ctx.task.event.userId,
            approvalPromptTs,
            logStep,
          });

          if (!approval.approved) {
            await postSlackProgress({ slack, ctx, text: "Got it, cancelling." });
            aborted = true;
            break;
          }
        }
      }
    }

    // After coder completes: strike through all plan steps to show completion
    if (role === 'coder' && planMessageTs && planSteps.length > 0) {
      const allCompleted = new Set(planSteps.map((_, idx) => idx));
      await updateSlackMessage({
        slack,
        ctx,
        ts: planMessageTs,
        text: formatPlanMessage(planSteps, planAffectedFiles, planScope, allCompleted, ctx.repoPath),
      });
    }

    // Abort on critical security/reviewer finding
    if (abortOnCriticalFinding && hasCriticalFinding(findings)) {
      logStep({
        stage: 'pipeline.abort',
        message: `Pipeline aborted due to critical finding from ${role}.`,
        level: 'ERROR',
        data: { role, criticalFindings: findings.filter(f => f.severity === 'critical') },
      });
      aborted = true;
      break;
    }

    // Feedback loop: reviewer rejects → re-run coder → re-run reviewer
    if (role === 'reviewer' && status === 'failed' && retryLoops < maxRetryLoops) {
      const coderIndex = agents.indexOf('coder');
      if (coderIndex !== -1 && coderIndex < i) {
        retryLoops++;
        logStep({
          stage: 'pipeline.feedback_loop',
          message: `Reviewer rejected; re-running coder (loop ${retryLoops}/${maxRetryLoops}).`,
          level: 'WARN',
          data: { retryLoops, maxRetryLoops },
        });

        await postSlackProgress({
          slack,
          ctx,
          text: `Reviewer flagged issues — sending feedback to the coding agent for revision (attempt ${retryLoops}/${maxRetryLoops}).`,
        });

        // Re-run coder with reviewer feedback in context
        const coderPrompt = buildPromptForRole('coder', {
          ...ctx,
          previousSteps: steps,
        });
        const coderProfile = profileForAgentRole('coder', getActiveBackendId());
        const coderSchemaPath = undefined; // coder has no dedicated schema
        const coderStart = Date.now();

        const coderRetryResult = await runCodex({
          cwd: ctx.repoPath,
          prompt: coderPrompt,
          outputSchemaPath: coderSchemaPath,
          githubToken: ctx.githubToken,
          ...coderProfile,
          onLog: logStep,
        });

        const coderRetryDuration = Date.now() - coderStart;
        const coderOutput = coderRetryResult.parsedJson ?? {};
        const coderFindings = extractFindings(coderOutput);
        const coderStatus = coderRetryResult.ok ? determineStepStatus(coderOutput, coderFindings) : 'failed';

        steps.push({
          role: 'coder',
          status: coderStatus,
          output: coderOutput,
          findings: coderFindings,
          durationMs: coderRetryDuration,
        });

        // Re-run reviewer
        i--; // Will increment back to reviewer on next iteration
        continue;
      }
    }
  }

  const totalDurationMs = Date.now() - pipelineStart;
  const aggregatedFindings = steps.flatMap(s => s.findings);

  // Check only the latest step for each role (feedback loops may produce
  // earlier failed steps that were subsequently superseded by retries).
  const latestByRole = new Map<string, AgentStepResult>();
  for (const step of steps) {
    latestByRole.set(step.role, step);
  }
  const hasFailedStep = Array.from(latestByRole.values()).some(s => s.status === 'failed');
  const finalStatus = aborted ? 'aborted' : hasFailedStep ? 'failed' : 'passed';

  logStep({
    stage: 'pipeline.finish',
    message: `Pipeline finished: ${finalStatus} (${totalDurationMs}ms, ${retryLoops} retry loops, ${aggregatedFindings.length} total findings).`,
    level: finalStatus === 'passed' ? 'INFO' : 'WARN',
    data: { finalStatus, totalDurationMs, retryLoops, totalFindings: aggregatedFindings.length },
  });

  const durationSec = Math.round(totalDurationMs / 1000);
  const finishText = finalStatus === 'passed'
    ? `Done in ${durationSec}s. Preparing the summary.`
    : finalStatus === 'aborted'
      ? `Finished in ${durationSec}s. Review flagged some concerns — see the summary below.`
      : `Finished in ${durationSec}s with some issues flagged — details below.`;
  await postSlackProgress({ slack, ctx, text: finishText });

  if (store && jobId) {
    try {
      store.updatePipelineRun(pipelineRunId, {
        status: finalStatus,
        stepsJson: JSON.stringify(steps),
        retryLoops,
        totalDurationMs,
      });
    } catch {
      // Non-fatal
    }
  }

  return {
    steps,
    finalStatus,
    totalDurationMs,
    retryLoops,
    aggregatedFindings,
  };
}
