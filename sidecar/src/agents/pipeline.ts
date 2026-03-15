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
  planner: 'Planning agent is analyzing the task and building an execution plan.',
  coder: 'Coding agent is implementing the changes.',
  reviewer: 'Review agent is inspecting the code changes for quality and correctness.',
  security: 'Security agent is scanning for vulnerabilities and unsafe patterns.',
  performance: 'Performance agent is checking for regressions and bottlenecks.',
  verifier: 'Verification agent is running final checks to confirm everything works.',
};

function buildCompletionMessage(role: AgentRole, status: string, nextRole?: AgentRole): string {
  const roleName: Record<AgentRole, string> = {
    planner: 'Planning',
    coder: 'Implementation',
    reviewer: 'Code review',
    security: 'Security scan',
    performance: 'Performance check',
    verifier: 'Verification',
  };

  const done = `${roleName[role]} ${status === 'passed' ? 'complete' : 'flagged issues'}.`;

  if (!nextRole) return `${done} Pipeline finishing up.`;

  const transitions: Record<AgentRole, string> = {
    planner: 'Handing off the plan — ',
    coder: 'Code is ready — ',
    reviewer: 'Review wrapped up — ',
    security: 'Security check done — ',
    performance: 'Performance check done — ',
    verifier: 'All checks done — ',
  };

  const nextAction: Record<AgentRole, string> = {
    planner: 'starting implementation.',
    coder: 'moving to code review.',
    reviewer: 'running security scan.',
    security: 'checking performance.',
    performance: 'running final verification.',
    verifier: 'wrapping up.',
  };

  return `${done} ${transitions[role]}${nextAction[nextRole]}`;
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

function formatPlanMessage(planSteps: string[], affectedFiles: string[], scope: string, completedSteps?: Set<number>): string {
  const header = `*Execution Plan* (scope: ${scope}, ${affectedFiles.length} files affected)`;
  const stepLines = planSteps.map((step, i) => {
    const num = `${i + 1}.`;
    if (completedSteps?.has(i)) {
      return `~${num} ${step}~`;
    }
    return `${num} ${step}`;
  });
  const filesSection = affectedFiles.length > 0
    ? `\n\n*Affected files:*\n${affectedFiles.map(f => `• \`${f}\``).join('\n')}`
    : '';
  return `${header}\n${stepLines.join('\n')}${filesSection}`;
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
    text: `Multi-agent pipeline started (${agents.length} agents: ${agents.join(' → ')}). I'll keep you updated as each phase completes.`,
  });

  // Track plan message so we can update it with strikethroughs during execution
  let planMessageTs: string | undefined;
  let planSteps: string[] = [];
  let planAffectedFiles: string[] = [];
  let planScope = 'unknown';

  for (let i = 0; i < agents.length; i++) {
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
      timeoutMs: Math.min(perAgentTimeoutMs, totalTimeoutMs - (Date.now() - pipelineStart)),
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
          text: formatPlanMessage(planSteps, planAffectedFiles, planScope),
        });
      }
    }

    // After coder completes: strike through all plan steps to show completion
    if (role === 'coder' && planMessageTs && planSteps.length > 0) {
      const allCompleted = new Set(planSteps.map((_, idx) => idx));
      await updateSlackMessage({
        slack,
        ctx,
        ts: planMessageTs,
        text: formatPlanMessage(planSteps, planAffectedFiles, planScope, allCompleted),
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
          timeoutMs: Math.min(perAgentTimeoutMs, totalTimeoutMs - (Date.now() - pipelineStart)),
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
    ? `All ${agents.length} agents finished successfully in ${durationSec}s. Preparing final output.`
    : finalStatus === 'aborted'
      ? `Pipeline aborted after ${durationSec}s due to a critical finding.`
      : `Pipeline completed in ${durationSec}s with issues flagged by one or more agents.`;
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
