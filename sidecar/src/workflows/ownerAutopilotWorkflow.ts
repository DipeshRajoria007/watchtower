import os from 'node:os';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  NormalizedTask,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import { runCodex } from '../codex/runCodex.js';
import { HIGH_REASONING_CODEX_PROFILE } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { githubAuthModeHint, resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { fetchThreadContext } from '../slack/threadContext.js';
import { runAgentPipeline } from '../agents/pipeline.js';
import type { PipelineStore } from '../agents/pipeline.js';
import type { AgentRole, PipelineConfig } from '../agents/types.js';

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

function stripMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function isPresencePing(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[!?.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return true;
  }

  return [
    /^you there$/,
    /^are you there$/,
    /^can you hear me$/,
    /^ping$/,
    /^hi$/,
    /^hello$/,
    /^hey$/,
    /^yo$/,
    /^online$/,
    /^awake$/,
    /^alive$/,
  ].some(pattern => pattern.test(normalized));
}

function buildPresenceReply(eventTs: string): string {
  const variants = [
    "Yeah, I'm here. Drop the agenda item.",
    'Online and listening. Tell me what should move first.',
    'Present. Send the ask and I will handle the paperwork and the work.',
  ];

  let hash = 0;
  for (let i = 0; i < eventTs.length; i += 1) {
    hash = (hash * 31 + eventTs.charCodeAt(i)) >>> 0;
  }
  return variants[hash % variants.length];
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

function buildOwnerPrimaryPrompt(params: {
  task: NormalizedTask;
  config: AppConfig;
  workspaceRoot: string;
  githubToken?: string;
  threadContext: string;
}): string {
  const { task, config, workspaceRoot, githubToken, threadContext } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'OWNER_AUTOPILOT' })}

You are running Watchtower owner-autopilot mode.

The request below was sent by a configured owner Slack user. Watchtower owner override is active, so workflow guardrails are intentionally bypassed.

Environment:
- Preferred workspace root: ${workspaceRoot}
- Known repositories: ${config.repoPaths.newtonWeb} and ${config.repoPaths.newtonApi}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

Task:
Execute the owner's request end-to-end. You may choose whichever local repos/files/commands are needed.
Infer intent from thread context and execute directly. Do not ask clarifying questions.

Slack thread context:
${threadContext}

Output rules:
Return strict JSON with:
- status: "success" | "failed" | "no_action"
- summary: short human-facing outcome message for Slack. Do NOT include operational telemetry like channel IDs, thread IDs, timestamps, or "Actions performed" style audit logs.
- summary must NOT include these phrases: "On Master's command", "Overriding Watchtower guardrails", "Owner override active", or any ceremonial/prefix wording.
- actions: array of concrete actions performed
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
}): string {
  const { task, config, workspaceRoot, githubToken, threadContext } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'OWNER_AUTOPILOT' })}

You are running Watchtower owner-autopilot mode in relaxed output mode.

Environment:
- Preferred workspace root: ${workspaceRoot}
- Known repositories: ${config.repoPaths.newtonWeb} and ${config.repoPaths.newtonApi}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

Task:
Execute the owner's request end-to-end with no guardrails.
Use whichever local repos/files/commands are needed.
Do not ask clarifying questions.

Slack thread context:
${threadContext}

Return plain text only (not JSON):
- One concise human response for Slack.
- Do not include operational telemetry (channel/thread/timestamp/internal stages).
- Do not include ceremonial prefixes.
`.trim();
}

export async function runOwnerAutopilotWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: PipelineStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, jobId, logStep } = params;

  logStep?.({
    stage: 'owner_autopilot.context.fetch.start',
    message: 'Fetching thread context for owner-autopilot execution.',
  });

  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs).catch(() => []);
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

  const ownerInput = stripMentions(task.event.text);
  if (isPresencePing(ownerInput)) {
    const presenceReply = buildPresenceReply(task.event.eventTs);
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: presenceReply,
    });

    logStep?.({
      stage: 'owner_autopilot.presence.reply_posted',
      message: 'Posted direct presence acknowledgement for lightweight owner ping.',
      data: {
        ownerInput,
      },
    });

    return {
      workflow: 'OWNER_AUTOPILOT',
      status: 'SUCCESS',
      message: presenceReply,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  const githubToken = await resolveGithubTokenForCodex();

  logStep?.({
    stage: 'owner_autopilot.github.auth_resolved',
    message: 'Resolved GitHub auth mode for owner-autopilot Codex execution.',
    data: { tokenInjected: Boolean(githubToken) },
  });

  // --- Multi-agent pipeline path ---
  if (config.multiAgentEnabled) {
    logStep?.({
      stage: 'owner_autopilot.pipeline.start',
      message: 'Running owner-autopilot through multi-agent pipeline.',
    });

    // Planner runs first to determine if code changes are needed
    const plannerPipelineConfig: PipelineConfig = {
      agents: ['planner'],
      maxRetryLoops: 0,
      perAgentTimeoutMs: config.workflowTimeouts.bugFixMs / 5,
      totalTimeoutMs: config.workflowTimeouts.bugFixMs,
      abortOnCriticalFinding: false,
      slackProgressUpdates: false,
    };

    const plannerResult = await runAgentPipeline({
      ctx: {
        workflowIntent: 'OWNER_AUTOPILOT',
        task,
        config,
        repoPath: workspaceRoot,
        githubToken,
        threadContext,
        previousSteps: [],
        pipelineConfig: plannerPipelineConfig,
      },
      slack,
      logStep: logStep ?? (() => {}),
      store,
      jobId,
    });

    const plannerOutput = plannerResult.steps[0]?.output ?? {};
    const requiresCodeChanges = Boolean(plannerOutput.requiresCodeChanges);

    if (requiresCodeChanges) {
      // Full pipeline: planner -> coder -> reviewer -> verifier
      const fullPipelineConfig: PipelineConfig = {
        agents: ['planner', 'coder', 'reviewer', 'verifier'],
        maxRetryLoops: 2,
        perAgentTimeoutMs: config.workflowTimeouts.bugFixMs / 4,
        totalTimeoutMs: config.workflowTimeouts.bugFixMs,
        abortOnCriticalFinding: true,
        slackProgressUpdates: true,
      };

      const fullResult = await runAgentPipeline({
        ctx: {
          workflowIntent: 'OWNER_AUTOPILOT',
          task,
          config,
          repoPath: workspaceRoot,
          githubToken,
          threadContext,
          previousSteps: [],
          pipelineConfig: fullPipelineConfig,
        },
        slack,
        logStep: logStep ?? (() => {}),
        store,
        jobId,
      });

      const coderStep = fullResult.steps.find(s => s.role === 'coder');
      const rawCoderSummary = coderStep?.output?.summary
        ? sanitizeOwnerSummary(String(coderStep.output.summary))
        : '';
      const summary = rawCoderSummary
        || (fullResult.finalStatus === 'passed'
          ? 'Pipeline completed but the agent did not return a summary. Check the repo for changes.'
          : `Pipeline finished with status: ${fullResult.finalStatus}. The agent did not produce output — it may not be installed or may have timed out.`);
      const prUrl = coderStep?.output?.prUrl ? String(coderStep.output.prUrl) : '';
      const prBlock = prUrl ? `\n${prUrl}` : '';

      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: `${summary}${prBlock}`.trim(),
      });

      return {
        workflow: 'OWNER_AUTOPILOT',
        status: fullResult.finalStatus === 'passed' ? 'SUCCESS' : 'FAILED',
        message: summary,
        notifyDesktop: false,
        slackPosted: true,
      };
    }

    // Planner-only fast path (no code changes needed)
    const planSummary = plannerOutput.plan
      ? (plannerOutput.plan as string[]).join('. ')
      : 'No action needed.';
    const sanitized = sanitizeOwnerSummary(planSummary);
    const plannerMessage = sanitized || 'Planner finished but produced no actionable summary. The agent backend may not be installed or returned empty output.';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: plannerMessage,
    });

    return {
      workflow: 'OWNER_AUTOPILOT',
      status: 'SUCCESS',
      message: plannerMessage,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  // --- Single-agent path (legacy) ---
  const prompt = buildOwnerPrimaryPrompt({
    task,
    config,
    workspaceRoot,
    githubToken,
    threadContext,
  });

  const request: CodexRunRequest = {
    cwd: workspaceRoot,
    prompt,
    timeoutMs: config.workflowTimeouts.bugFixMs,
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/owner-autopilot-result.schema.json'),
    githubToken,
    ...HIGH_REASONING_CODEX_PROFILE,
    onLog: logStep,
  };

  logStep?.({
    stage: 'owner_autopilot.codex.start',
    message: 'Starting owner-autopilot Codex execution with high-reasoning profile.',
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

  const primaryTextFallback =
    result.ok && !result.parsedJson
      ? sanitizeOwnerSummary(result.lastMessage || result.stdout)
      : '';

  if (primaryTextFallback) {
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: primaryTextFallback,
    });

    logStep?.({
      stage: 'owner_autopilot.slack.primary_text_fallback_posted',
      message: 'Posted primary owner-autopilot plain-text response without relaxed retry.',
      level: 'WARN',
      data: {
        bytes: Buffer.byteLength(primaryTextFallback),
      },
    });

    return {
      workflow: 'OWNER_AUTOPILOT',
      status: 'SUCCESS',
      message: primaryTextFallback,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (!result.ok || !result.parsedJson) {
    logStep?.({
      stage: 'owner_autopilot.codex.retry_relaxed.start',
      message: 'Primary owner-autopilot output failed; retrying Codex in relaxed text mode.',
      level: 'WARN',
      data: {
        primaryOk: result.ok,
        primaryExitCode: result.exitCode,
        primaryParsedJson: Boolean(result.parsedJson),
      },
    });

    const relaxedPrompt = buildOwnerRelaxedPrompt({
      task,
      config,
      workspaceRoot,
      githubToken,
      threadContext,
    });
    const relaxedResult = await runCodex({
      cwd: workspaceRoot,
      prompt: relaxedPrompt,
      timeoutMs: config.workflowTimeouts.bugFixMs,
      githubToken,
      ...HIGH_REASONING_CODEX_PROFILE,
      onLog: logStep,
    });

    logStep?.({
      stage: 'owner_autopilot.codex.retry_relaxed.finish',
      message: 'Relaxed owner-autopilot Codex execution finished.',
      level: relaxedResult.ok ? 'INFO' : 'WARN',
      data: {
        ok: relaxedResult.ok,
        timedOut: relaxedResult.timedOut,
        exitCode: relaxedResult.exitCode,
        lastMessageBytes: Buffer.byteLength(relaxedResult.lastMessage),
      },
    });

    if (relaxedResult.ok) {
      const relaxedSummaryRaw = relaxedResult.lastMessage || relaxedResult.stdout;
      const relaxedSummary = sanitizeOwnerSummary(relaxedSummaryRaw || '');
      const messageText = relaxedSummary || 'Workflow completed but the agent returned empty output. Verify the configured backend CLI is installed and working.';

      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: messageText,
      });

      logStep?.({
        stage: 'owner_autopilot.slack.relaxed_success_posted',
        message: 'Posted relaxed-mode owner-autopilot response in Slack thread.',
      });

      return {
        workflow: 'OWNER_AUTOPILOT',
        status: 'SUCCESS',
        message: messageText,
        notifyDesktop: false,
        slackPosted: true,
      };
    }

    const technicalError = result.timedOut
      ? 'Owner-autopilot workflow timed out.'
      : `Owner-autopilot workflow failed (exit=${result.exitCode ?? 'unknown'}).`;
    const userFacingMessage =
      'I hit an execution issue right now. Ask me again in a moment, or share the task in one line and I will retry.';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: userFacingMessage,
    });

    logStep?.({
      stage: 'owner_autopilot.slack.recoverable_posted',
      message: 'Posted recoverable owner-autopilot retry prompt in Slack thread.',
      level: 'WARN',
      data: {
        technicalError,
        timedOut: result.timedOut,
        exitCode: result.exitCode,
      },
    });

    notifyDesktop('Watchtower owner-autopilot failed', `${technicalError} thread=${task.event.threadTs}`);

    return {
      workflow: 'OWNER_AUTOPILOT',
      status: 'PAUSED',
      message: userFacingMessage,
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  const rawStatus = String(result.parsedJson.status ?? 'success');
  const normalizedStatus = rawStatus === 'needs_clarification' ? 'no_action' : rawStatus;
  const status = normalizedStatus === 'success' || normalizedStatus === 'failed' || normalizedStatus === 'no_action'
    ? normalizedStatus
    : 'failed';
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
