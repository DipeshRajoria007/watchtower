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
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { githubAuthModeHint, resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { fetchThreadContext } from '../slack/threadContext.js';
import { downloadSlackImages } from '../slack/imageDownloader.js';
import { classifyRepo } from '../router/repoClassifier.js';
import { getBackend } from '../backends/registry.js';
import { runAgentPipeline } from '../agents/pipeline.js';
import type { PipelineStore } from '../agents/pipeline.js';
import type { PipelineConfig } from '../agents/types.js';

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
  imageContext: string;
}): string {
  const { task, config, workspaceRoot, githubToken, threadContext, imageContext } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'OWNER_AUTOPILOT' })}

You are running Watchtower owner-autopilot mode.

The request below was sent by a configured owner Slack user. Watchtower owner override is active, so workflow guardrails are intentionally bypassed.

Environment:
- Preferred workspace root: ${workspaceRoot}
- Known repositories: ${config.repoPaths.newtonWeb} and ${config.repoPaths.newtonApi}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

Task:
Read the owner's message carefully. It may be an actionable engineering task OR a conversational message (greeting, question, status check, casual chat).

- If the message is an actionable task (code change, PR, bug fix, deployment, file operation, etc.): execute it end-to-end. You may choose whichever local repos/files/commands are needed. Infer intent from thread context and execute directly.
- If the message is conversational (greeting, presence check, question about capabilities, casual chat, or anything that does not require code/infrastructure changes): respond naturally and helpfully as an AI assistant. Be friendly, concise, and human. Do not fabricate actions you did not perform.

Slack thread context:
${threadContext}${imageContext}

Output rules:
Return strict JSON with:
- status: "success" | "failed" | "no_action"
- summary: short human-facing outcome message for Slack. For conversational messages, this is your natural reply to the user. For tasks, this is the outcome description. Do NOT include operational telemetry like channel IDs, thread IDs, timestamps, or "Actions performed" style audit logs.
- summary must NOT include these phrases: "On Master's command", "Overriding Watchtower guardrails", "Owner override active", or any ceremonial/prefix wording.
- actions: array of concrete actions performed (empty array if conversational)
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
  const { task, config, workspaceRoot, githubToken, threadContext, imageContext } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'OWNER_AUTOPILOT' })}

You are running Watchtower owner-autopilot mode in relaxed output mode.

Environment:
- Preferred workspace root: ${workspaceRoot}
- Known repositories: ${config.repoPaths.newtonWeb} and ${config.repoPaths.newtonApi}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

Task:
Read the owner's message carefully. It may be an actionable engineering task OR a conversational message (greeting, question, status check, casual chat).

- If the message is an actionable task (code change, PR, bug fix, deployment, file operation, etc.): execute it end-to-end with no guardrails. Use whichever local repos/files/commands are needed. Do not ask clarifying questions.
- If the message is conversational (greeting, presence check, question about capabilities, casual chat, or anything that does not require code/infrastructure changes): respond naturally and helpfully as an AI assistant. Be friendly, concise, and human. Do not fabricate actions you did not perform.

Slack thread context:
${threadContext}${imageContext}

Return plain text only (not JSON):
- One concise human response for Slack.
- For conversational messages, just reply naturally.
- Do not include operational telemetry (channel/thread/timestamp/internal stages).
- Do not include ceremonial prefixes.
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
${buildMentionSystemPrompt({ task, workflow: 'OWNER_AUTOPILOT' })}

You are running Watchtower autopilot mode with repository-scoped guardrails.

Environment:
- Working directory: ${repoPath}
- Repository: ${repoName}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

GUARDRAILS:
- Work only within this repository directory. Do not access or modify files outside of it.
- Do not run destructive git commands (force push, reset --hard, etc.).

Task:
Read the user's message carefully. It may be an actionable engineering task OR a conversational message (greeting, question about the codebase, status check, or general inquiry).

- If the message is an actionable task (code change, bug fix, feature implementation, etc.): implement it within the repository. Create a branch, commit your changes, and open a PR to the default branch.
- If the message is conversational (question about the codebase, how something works, where to find something, etc.): respond naturally and helpfully. You can read code to answer questions without making changes.

Slack thread context:
${threadContext}${imageContext}

Output rules:
Return strict JSON with:
- status: "success" | "failed" | "no_action"
- summary: short human-facing outcome message for Slack
- actions: array of concrete actions performed (empty array if conversational)
- prUrl: PR URL if one was created, else empty string
- confidence: number between 0 and 1
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
  const isOwnerAuthor = config.ownerSlackUserIds.includes(task.event.userId);

  logStep?.({
    stage: 'owner_autopilot.context.fetch.start',
    message: 'Fetching thread context for owner-autopilot execution.',
    data: { isOwnerAuthor },
  });

  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs).catch(() => []);
  const threadContext = formatThreadContext(task, threadMessages);

  // --- Resolve working directory based on trust level ---
  let cwd: string;
  let repoName: string | undefined;

  if (isOwnerAuthor) {
    cwd = resolveOwnerWorkspaceRoot(config);
  } else {
    // Non-owner: classify repo and restrict to that path
    const texts = [task.event.text, ...threadMessages.map(m => m.text)];
    const classification = classifyRepo(texts, config.repoClassifierThreshold);

    logStep?.({
      stage: 'owner_autopilot.repo.classified',
      message: 'Classified repository for guardrailed execution.',
      data: {
        selectedRepo: classification.selectedRepo,
        confidence: classification.confidence,
        uncertain: classification.uncertain,
      },
    });

    if (classification.uncertain || !classification.selectedRepo) {
      notifyDesktop(
        'Watchtower uncertain repo classification',
        `Could not confidently classify task thread ${task.event.threadTs} (confidence=${classification.confidence.toFixed(2)}).`
      );

      return {
        workflow: 'OWNER_AUTOPILOT',
        status: 'SKIPPED',
        message: 'Repo classification uncertain; desktop notification only.',
        notifyDesktop: true,
        slackPosted: false,
        result: { classification },
      };
    }

    repoName = classification.selectedRepo;
    cwd = classification.selectedRepo === 'newton-web'
      ? config.repoPaths.newtonWeb
      : config.repoPaths.newtonApi;
  }

  logStep?.({
    stage: 'owner_autopilot.context.fetch.done',
    message: 'Thread context resolved for owner-autopilot execution.',
    data: {
      messages: threadMessages.length,
      cwd,
      isOwnerAuthor,
    },
  });

  logStep?.({
    stage: 'owner_autopilot.slack.ack_skipped',
    message: 'Skipped owner-autopilot acknowledgement message by configuration.',
  });

  const userInput = stripMentions(task.event.text);
  if (isPresencePing(userInput)) {
    const presenceReply = buildPresenceReply(task.event.eventTs);
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: presenceReply,
    });

    logStep?.({
      stage: 'owner_autopilot.presence.reply_posted',
      message: 'Posted direct presence acknowledgement for lightweight ping.',
      data: { userInput },
    });

    return {
      workflow: 'OWNER_AUTOPILOT',
      status: 'SUCCESS',
      message: presenceReply,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  // --- Download images from thread ---
  const allFiles = threadMessages.flatMap(m => m.files ?? []);
  let imagePaths: string[] = [];
  if (allFiles.length > 0) {
    logStep?.({
      stage: 'owner_autopilot.images.download.start',
      message: `Downloading ${allFiles.length} image(s) from thread.`,
    });
    try {
      imagePaths = await downloadSlackImages({
        files: allFiles,
        botToken: config.slackBotToken,
      });
      logStep?.({
        stage: 'owner_autopilot.images.download.done',
        message: `Downloaded ${imagePaths.length} image(s).`,
        data: { count: imagePaths.length },
      });
    } catch (error) {
      logStep?.({
        stage: 'owner_autopilot.images.download.error',
        message: `Image download failed: ${String(error)}`,
        level: 'WARN',
      });
    }
  }

  const backend = getBackend(getActiveBackendId());
  const imageContext = imagePaths.length > 0 && !backend.supportsImages()
    ? `\n\n[${imagePaths.length} image(s) attached in thread — this backend does not support image input]`
    : '';

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
      data: { isOwnerAuthor },
    });

    // Planner runs first to determine if code changes are needed
    const plannerPipelineConfig: PipelineConfig = {
      agents: ['planner'],
      maxRetryLoops: 0,
      abortOnCriticalFinding: false,
      slackProgressUpdates: false,
    };

    const plannerResult = await runAgentPipeline({
      ctx: {
        workflowIntent: 'OWNER_AUTOPILOT',
        task,
        config,
        repoPath: cwd,
        githubToken,
        threadContext,
        previousSteps: [],
        pipelineConfig: plannerPipelineConfig,
        imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
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
        abortOnCriticalFinding: true,
        slackProgressUpdates: true,
      };

      const fullResult = await runAgentPipeline({
        ctx: {
          workflowIntent: 'OWNER_AUTOPILOT',
          task,
          config,
          repoPath: cwd,
          githubToken,
          threadContext,
          previousSteps: [],
          pipelineConfig: fullPipelineConfig,
          imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
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

  // --- Single-agent path ---
  const prompt = isOwnerAuthor
    ? buildOwnerPrimaryPrompt({
        task,
        config,
        workspaceRoot: cwd,
        githubToken,
        threadContext,
        imageContext,
      })
    : buildGuardrailedPrompt({
        task,
        repoPath: cwd,
        repoName: repoName ?? 'unknown',
        githubToken,
        threadContext,
        imageContext,
      });

  const request: CodexRunRequest = {
    cwd,
    prompt,

    outputSchemaPath: path.resolve(process.cwd(), 'schemas/owner-autopilot-result.schema.json'),
    githubToken,
    imagePaths: imagePaths.length > 0 && backend.supportsImages() ? imagePaths : undefined,
    ...highReasoningProfile(getActiveBackendId()),
    onLog: logStep,
  };

  logStep?.({
    stage: 'owner_autopilot.codex.start',
    message: 'Starting owner-autopilot Codex execution with high-reasoning profile.',
    data: {
      cwd,
  
      isOwnerAuthor,
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
    // Only owners get the relaxed retry path
    if (isOwnerAuthor) {
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
        workspaceRoot: cwd,
        githubToken,
        threadContext,
        imageContext,
      });
      const relaxedResult = await runCodex({
        cwd,
        prompt: relaxedPrompt,
    
        githubToken,
        imagePaths: imagePaths.length > 0 && backend.supportsImages() ? imagePaths : undefined,
        ...highReasoningProfile(getActiveBackendId()),
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
  // When the agent returns no_action with high confidence and a summary,
  // it's a conversational reply — skip the "No action required." prefix.
  const isConversationalNoAction =
    status === 'no_action' && summary && (Number.isFinite(confidence) ? confidence >= 0.8 : true);
  const statusIntro =
    status === 'success' || isConversationalNoAction
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
