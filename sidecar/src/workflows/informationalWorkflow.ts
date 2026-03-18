import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { githubAuthModeHint } from '../github/githubAuth.js';
import { prepareWorkflowContext, sanitizeOwnerSummary } from './shared/workflowUtils.js';

export async function runInformationalWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, logStep, signal } = params;

  logStep?.({
    stage: 'informational.start',
    message: 'Running informational workflow.',
  });

  const ctx = await prepareWorkflowContext({ task, config, slack, logStep });

  const prompt = `
${buildMentionSystemPrompt({ task, workflow: 'INFORMATIONAL' })}

You are miniOG, a developer assistant. The user is asking a question or requesting information about the codebase.

Environment:
- Working directory: ${ctx.cwd}
- GitHub auth mode: ${githubAuthModeHint(Boolean(ctx.githubToken))}

Task:
Read the user's message and answer their question. You have READ-ONLY access to the codebase — you can read files, search code, and explain things.

IMPORTANT:
- Do NOT modify any files, create branches, or make commits
- Do NOT run destructive commands
- Answer thoroughly but concisely
- If you need to reference code, quote the relevant parts

Slack thread context:
${ctx.threadContext}${ctx.imageContext}

Reply with a clear, helpful answer. Plain text only (not JSON).
`.trim();

  const result = await runCodex({
    cwd: ctx.cwd,
    prompt,
    githubToken: ctx.githubToken,
    imagePaths: ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
    ...highReasoningProfile(getActiveBackendId()),
    onLog: logStep,
    signal,
  });

  logStep?.({
    stage: 'informational.codex.done',
    message: 'Informational codex execution finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: { ok: result.ok, exitCode: result.exitCode },
  });

  const rawReply = result.lastMessage?.trim() || result.stdout?.trim() || '';
  const reply = sanitizeOwnerSummary(rawReply) || 'I could not find a clear answer. Try rephrasing your question.';

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: reply,
  });

  logStep?.({
    stage: 'informational.done',
    message: 'Posted informational reply.',
  });

  return {
    workflow: 'INFORMATIONAL',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    message: reply,
    notifyDesktop: false,
    slackPosted: true,
  };
}
