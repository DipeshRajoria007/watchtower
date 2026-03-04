import os from 'node:os';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, CodexRunRequest, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex } from '../codex/runCodex.js';
import { githubAuthModeHint, resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { fetchThreadContext } from '../slack/threadContext.js';

function resolveOwnerWorkspaceRoot(config: AppConfig): string {
  const webParent = path.dirname(config.repoPaths.newtonWeb);
  const apiParent = path.dirname(config.repoPaths.newtonApi);
  if (webParent === apiParent) {
    return webParent;
  }
  return process.env.HOME ?? os.homedir();
}

function formatThreadContext(task: NormalizedTask, messages: Array<{ text: string; user: string; ts: string }>): string {
  const lines: string[] = [];
  lines.push(`[root] user=${task.event.userId} ts=${task.event.eventTs}`);
  lines.push(task.event.text);

  for (const message of messages) {
    lines.push(`---`);
    lines.push(`[thread] user=${message.user} ts=${message.ts}`);
    lines.push(message.text);
  }

  return lines.join('\n');
}

function sanitizeOwnerSummary(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  let cleaned = normalized
    .replace(/on\s+master'?s?\s+command[,:\-\s]*overriding\s+watchtower\s+guardrails\.?/gi, '')
    .replace(/overriding\s+watchtower\s+guardrails\.?/gi, '')
    .replace(/^master your task is completed\.?\s*/i, '')
    .replace(/^owner request success\.?\s*/i, '')
    .replace(/^request success\.?\s*/i, '');

  // Drop verbose execution-audit blocks even when they are inline.
  cleaned = cleaned.replace(/\bactions?:[\s\S]*$/i, '');
  cleaned = cleaned
    .replace(/\b(posted|replied|verified|confirmed)\b[^.\n]*(slack|thread|channel|timestamp)[^.\n]*\.?/gi, '')
    .replace(/\bowner.?s?\s+slack\s+thread\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const lines = cleaned
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^actions?:/i.test(line))
    .filter(line => !/^-\s*/.test(line))
    .filter(line => !/(channel\s+[A-Z0-9]+|thread\s+\d+\.\d+|timestamp|slack thread|replied in slack|posted in slack|confirmed slack)/i.test(line))
    .filter(line => !/^on master's command/i.test(line));

  const finalText = lines.join(' ').replace(/\s+/g, ' ').trim();
  return finalText;
}

export async function runOwnerAutopilotWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, config, slack, logStep } = params;

  logStep?.({
    stage: 'owner_autopilot.context.fetch.start',
    message: 'Fetching thread context for owner-autopilot execution.',
  });

  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs);
  const workspaceRoot = resolveOwnerWorkspaceRoot(config);
  const threadContext = formatThreadContext(task, threadMessages);

  logStep?.({
    stage: 'owner_autopilot.context.fetch.done',
    message: 'Thread context resolved for owner-autopilot execution.',
    data: {
      messages: threadMessages.length,
      workspaceRoot,
    },
  });

  logStep?.({
    stage: 'owner_autopilot.slack.ack_skipped',
    message: 'Skipped owner-autopilot acknowledgement message by configuration.',
  });

  const githubToken = await resolveGithubTokenForCodex();

  logStep?.({
    stage: 'owner_autopilot.github.auth_resolved',
    message: 'Resolved GitHub auth mode for owner-autopilot Codex execution.',
    data: { tokenInjected: Boolean(githubToken) },
  });

  const prompt = `
You are running Watchtower owner-autopilot mode.

The request below was sent by a configured owner Slack user. Watchtower owner override is active, so workflow guardrails are intentionally bypassed.

Environment:
- Preferred workspace root: ${workspaceRoot}
- Known repositories: ${config.repoPaths.newtonWeb} and ${config.repoPaths.newtonApi}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

Task:
Execute the owner's request end-to-end. You may choose whichever local repos/files/commands are needed.
If the request is ambiguous or missing key details, do not guess dangerously: ask one concise clarifying question instead.

Slack thread context:
${threadContext}

Output rules:
Return strict JSON with:
- status: "success" | "failed" | "no_action" | "needs_clarification"
- summary: short human-facing outcome message for Slack. Do NOT include operational telemetry like channel IDs, thread IDs, timestamps, or "Actions performed" style audit logs.
- summary must NOT include these phrases: "On Master's command", "Overriding Watchtower guardrails", "Owner override active", or any ceremonial/prefix wording.
- for status="needs_clarification", summary must be one direct question asking only the minimum missing info.
- actions: array of concrete actions performed
- prUrl: PR URL if one was created, else empty string
- confidence: number between 0 and 1
`.trim();

  const request: CodexRunRequest = {
    cwd: workspaceRoot,
    prompt,
    timeoutMs: config.workflowTimeouts.bugFixMs,
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/owner-autopilot-result.schema.json'),
    githubToken,
    onLog: logStep,
  };

  logStep?.({
    stage: 'owner_autopilot.codex.start',
    message: 'Starting owner-autopilot Codex execution.',
    data: {
      workspaceRoot,
      timeoutMs: config.workflowTimeouts.bugFixMs,
    },
  });

  const result = await runCodex(request);

  logStep?.({
    stage: 'owner_autopilot.codex.finish',
    message: 'Owner-autopilot Codex execution finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: {
      ok: result.ok,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      parsedJson: Boolean(result.parsedJson),
    },
  });

  if (!result.ok || !result.parsedJson) {
    const errorText = result.timedOut
      ? 'Owner-autopilot workflow timed out.'
      : `Owner-autopilot workflow failed (exit=${result.exitCode ?? 'unknown'}).`;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `${errorText} Check execution trace for details.`,
    });

    logStep?.({
      stage: 'owner_autopilot.slack.failure_posted',
      message: 'Posted owner-autopilot failure message in Slack thread.',
      level: 'ERROR',
      data: {
        errorText,
      },
    });

    notifyDesktop('Watchtower owner-autopilot failed', `${errorText} thread=${task.event.threadTs}`);

    return {
      workflow: 'OWNER_AUTOPILOT',
      status: 'FAILED',
      message: errorText,
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  const status = String(result.parsedJson.status ?? 'success');
  const confidence = Number(result.parsedJson.confidence ?? Number.NaN);
  const summaryRaw = String(result.parsedJson.summary ?? 'Owner request completed.');
  const summary = sanitizeOwnerSummary(summaryRaw);
  const prUrl = String(result.parsedJson.prUrl ?? '');
  const statusIntro =
    status === 'success'
      ? ''
      : status === 'no_action'
        ? 'No action required.'
        : `Request ${status}.`;

  if (status === 'needs_clarification') {
    const clarifyingQuestion =
      summary ||
      'Could you clarify the exact task and expected output so I can execute it correctly?';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: clarifyingQuestion,
    });

    logStep?.({
      stage: 'owner_autopilot.clarification.posted',
      message: 'Posted clarifying question and paused owner-autopilot execution.',
      level: 'WARN',
      data: {
        confidence: Number.isFinite(confidence) ? confidence : null,
      },
    });

    return {
      workflow: 'OWNER_AUTOPILOT',
      status: 'PAUSED',
      message: clarifyingQuestion,
      notifyDesktop: false,
      slackPosted: true,
      result: result.parsedJson,
    };
  }

  const shouldSuppressMetaReply =
    !prUrl &&
    (!summary ||
      /\b(posted|replied|verified|confirmed)\b[^.\n]*(slack|thread|channel|timestamp)/i.test(summaryRaw) ||
      /\bactions?:/i.test(summaryRaw));

  if (!shouldSuppressMetaReply) {
    const prBlock = prUrl ? `\n${prUrl}` : '';
    const text = `${statusIntro ? `${statusIntro} ` : ''}${summary}${prBlock}`.trim();
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });
  }

  logStep?.({
    stage: shouldSuppressMetaReply
      ? 'owner_autopilot.slack.success_suppressed'
      : 'owner_autopilot.slack.success_posted',
    message: shouldSuppressMetaReply
      ? 'Suppressed owner-autopilot meta completion message.'
      : 'Posted owner-autopilot completion message in Slack thread.',
    data: {
      status,
      hasPrUrl: Boolean(prUrl),
      suppressed: shouldSuppressMetaReply,
      confidence: Number.isFinite(confidence) ? confidence : null,
    },
  });

  return {
    workflow: 'OWNER_AUTOPILOT',
    status: status === 'failed' ? 'FAILED' : 'SUCCESS',
    message: summary || 'Owner request completed.',
    notifyDesktop: false,
    slackPosted: !shouldSuppressMetaReply,
    result: result.parsedJson,
  };
}
