import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { githubAuthModeHint } from '../github/githubAuth.js';
import { prepareWorkflowContext, extractReplyFromCodexResult } from './shared/workflowUtils.js';

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

Context:
- You are miniOG, a developer assistant bot in a Slack workspace.
- The user @mentioned you in a Slack thread asking a question about the codebase.
- Your response will be posted DIRECTLY into that Slack thread as-is. No transformation, no wrapping — what you write is exactly what the user sees.
- You have READ-ONLY access to the codebase at: ${ctx.cwd}
- GitHub auth mode: ${githubAuthModeHint(Boolean(ctx.githubToken))}

Instructions:
- Answer the user's question thoroughly but concisely.
- You can read files, search code, and explain things. Do NOT modify any files, create branches, or make commits.
- Write your response as a ready-to-post Slack message.
- Use Slack markdown for formatting (*bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`, bullet lists).
- If you reference code, quote the relevant parts inline.

Slack thread context:
${ctx.threadContext}${ctx.imageContext}
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

  // Don't use sanitizeOwnerSummary here — it strips bullet-pointed lines (- item)
  // which destroys informational replies that list files, components, etc.
  const reply = extractReplyFromCodexResult(result) || 'I could not find a clear answer. Try rephrasing your question.';

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
