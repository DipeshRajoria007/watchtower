import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { prepareWorkflowContext } from './shared/workflowUtils.js';
import type { PipelineStore } from '../agents/pipeline.js';
import type { InvestigationStore } from '../state/investigationStore.js';

export async function runInvestigationWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: PipelineStore;
  investigationStore?: InvestigationStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, investigationStore, jobId, logStep, signal } = params;

  logStep?.({ stage: 'investigation.start', message: 'Running investigation workflow.' });

  const ctx = await prepareWorkflowContext({ task, config, slack, logStep });

  if (ctx.desktopOnly) {
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: `I couldn't pin down which repo to investigate (${ctx.desktopOnly.reason}) — routing this to the desktop queue.`,
      })
      .catch(() => {});
    return {
      workflow: 'INVESTIGATION',
      status: ctx.desktopOnly.cancelled ? 'CANCELLED' : 'PAUSED',
      message: `Routed to desktop (${ctx.desktopOnly.reason}).`,
      notifyDesktop: !ctx.desktopOnly.cancelled,
      slackPosted: true,
    };
  }

  const repoPath = ctx.cwd;
  const repoName = ctx.repoName;

  const investigatorPrompt = `
${buildMentionSystemPrompt({ task, workflow: 'INVESTIGATION' })}

You are the INVESTIGATOR agent.

Your job is to DIAGNOSE — not to fix. Read code, run read-only queries (git log / git show / grep / ls), and form a concrete hypothesis about what is wrong. Do NOT modify any files. Do NOT create branches. Do NOT run destructive commands. If you cannot form a hypothesis because the user's report is too vague, say so in \`requiresMoreInfo\` and list what you'd need.

Environment:
- Working directory: ${repoPath}${repoName ? ` (${repoName})` : ''}
- Read-only mode: you may use Read, Grep, Glob, and read-only git/bash (git log, git show, git blame, git diff). Do NOT invoke Edit, Write, or any bash command that mutates the worktree.

Slack thread context (includes the bug report and any evidence the user has shared):
${ctx.threadContext}${ctx.imageContext}

Return strict JSON:
{
  "rootCauseHypothesis": string,            // one-paragraph diagnosis, or "" if genuinely unclear
  "evidence": [                             // concrete citations supporting the hypothesis
    { "file": string, "line": number, "snippet": string, "why": string }
  ],
  "recommendedFix": string,                 // conceptual fix sketch (not code) — what should change
  "confidence": "low" | "medium" | "high",
  "requiresMoreInfo": string | null,        // null if the hypothesis stands on its own; otherwise a specific ask
  "summary": string                         // one-line Slack summary of what you found
}
`.trim();

  const profile = highReasoningProfile(getActiveBackendId());
  const investigatorResult = await runCodex({
    cwd: repoPath,
    prompt: investigatorPrompt,
    githubToken: ctx.githubToken,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    timeoutMs: Math.floor(config.bugFixTimeoutMs * 0.4),
    onLog: logStep,
    signal,
  });

  if (!investigatorResult.ok || !investigatorResult.parsedJson) {
    logStep?.({
      stage: 'investigation.failed',
      message: 'Investigator did not return valid JSON output.',
      level: 'ERROR',
    });
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: "I couldn't complete the investigation (the investigator agent failed to produce a readable diagnosis). Could you share more context about what's failing?",
      })
      .catch(() => {});
    return {
      workflow: 'INVESTIGATION',
      status: 'FAILED',
      message: 'Investigator produced no usable output.',
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  const findings = investigatorResult.parsedJson as {
    rootCauseHypothesis?: string;
    evidence?: Array<{ file?: string; line?: number; snippet?: string; why?: string }>;
    recommendedFix?: string;
    confidence?: 'low' | 'medium' | 'high';
    requiresMoreInfo?: string | null;
    summary?: string;
  };

  const message = formatInvestigationMessage(findings);

  await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: message,
    })
    .catch(() => {});

  if (findings.requiresMoreInfo) {
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: `_${findings.requiresMoreInfo}_\n\nReply here with more context and tag me again to continue.`,
      })
      .catch(() => {});
  } else {
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: 'Want me to fix this? Tag me again in this thread with "yes, fix it" (or tell me what you want me to do).',
      })
      .catch(() => {});
  }

  if (investigationStore && jobId) {
    try {
      investigationStore.save({
        threadTs: task.event.threadTs,
        channelId: task.event.channelId,
        jobId,
        repoName,
        repoPath,
        summary: findings.summary ?? findings.rootCauseHypothesis ?? '',
        findingsJson: JSON.stringify(findings),
      });
      logStep?.({
        stage: 'investigation.saved',
        message: 'Investigation findings persisted for future planner re-entry.',
      });
    } catch (err) {
      logStep?.({
        stage: 'investigation.save_failed',
        message: `Failed to persist investigation findings: ${err instanceof Error ? err.message : String(err)}`,
        level: 'WARN',
      });
    }
  }

  return {
    workflow: 'INVESTIGATION',
    status: 'SUCCESS',
    message: findings.summary ?? 'Investigation complete.',
    notifyDesktop: false,
    slackPosted: true,
  };
}

function formatInvestigationMessage(findings: {
  rootCauseHypothesis?: string;
  evidence?: Array<{ file?: string; line?: number; snippet?: string; why?: string }>;
  recommendedFix?: string;
  confidence?: 'low' | 'medium' | 'high';
  summary?: string;
}): string {
  const parts: string[] = [];
  if (findings.summary) parts.push(`*${findings.summary}*`);
  if (findings.rootCauseHypothesis) parts.push(`*Root cause:* ${findings.rootCauseHypothesis}`);

  if (findings.evidence && findings.evidence.length > 0) {
    const items = findings.evidence
      .slice(0, 5)
      .map(e => {
        const loc = e.file ? (e.line ? `\`${e.file}:${e.line}\`` : `\`${e.file}\``) : '';
        const why = e.why ? ` — ${e.why}` : '';
        return `• ${loc}${why}`;
      })
      .join('\n');
    parts.push(`*Evidence:*\n${items}`);
  }

  if (findings.recommendedFix) parts.push(`*Recommended fix:* ${findings.recommendedFix}`);
  if (findings.confidence) parts.push(`_Confidence: ${findings.confidence}_`);

  return parts.join('\n\n');
}
