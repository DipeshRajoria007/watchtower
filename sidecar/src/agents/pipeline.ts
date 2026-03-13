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
import { runCodex } from '../codex/runCodex.js';

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

async function postProgressUpdate(params: {
  slack: WebClient;
  ctx: AgentContext;
  stepIndex: number;
  totalSteps: number;
  role: AgentRole;
  status: string;
}): Promise<void> {
  if (!params.ctx.pipelineConfig.slackProgressUpdates) return;
  const { channelId, threadTs } = params.ctx.task.event;
  const text = `[${params.stepIndex + 1}/${params.totalSteps}] ${params.role}: ${params.status}`;
  try {
    await params.slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text,
    });
  } catch {
    // Non-fatal: progress update failure should not abort pipeline
  }
}

export async function runAgentPipeline(params: {
  ctx: AgentContext;
  slack: WebClient;
  logStep: WorkflowStepLogger;
}): Promise<PipelineResult> {
  const { ctx, slack, logStep } = params;
  const { agents, maxRetryLoops, perAgentTimeoutMs, totalTimeoutMs, abortOnCriticalFinding } = ctx.pipelineConfig;

  const pipelineStart = Date.now();
  const steps: AgentStepResult[] = [];
  let retryLoops = 0;
  let aborted = false;

  logStep({
    stage: 'pipeline.start',
    message: `Starting multi-agent pipeline with ${agents.length} agents.`,
    data: { agents, maxRetryLoops, totalTimeoutMs },
  });

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

    const prompt = buildPromptForRole(role, {
      ...ctx,
      previousSteps: steps,
    });

    const profile = profileForAgentRole(role);
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

    await postProgressUpdate({
      slack,
      ctx,
      stepIndex: i,
      totalSteps: agents.length,
      role,
      status,
    });

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

        // Re-run coder with reviewer feedback in context
        const coderPrompt = buildPromptForRole('coder', {
          ...ctx,
          previousSteps: steps,
        });
        const coderProfile = profileForAgentRole('coder');
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

  return {
    steps,
    finalStatus,
    totalDurationMs,
    retryLoops,
    aggregatedFindings,
  };
}
