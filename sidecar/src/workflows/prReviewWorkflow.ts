import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  NormalizedTask,
  PrContext,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import { fetchThreadContext } from '../slack/threadContext.js';
import { extractPrContext } from '../router/intentParser.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { runCodex } from '../codex/runCodex.js';
import { githubAuthModeHint, resolveGithubTokenForCodex } from '../github/githubAuth.js';

function mapRepoPath(config: AppConfig, pr: PrContext): string | null {
  if (pr.repo === 'newton-web') {
    return config.repoPaths.newtonWeb;
  }
  if (pr.repo === 'newton-api') {
    return config.repoPaths.newtonApi;
  }
  return null;
}

export async function runPrReviewWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, config, slack, logStep } = params;

  logStep?.({
    stage: 'pr_review.context.fetch.start',
    message: 'Fetching Slack thread context for PR review.',
  });

  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs);
  const threadTexts = threadMessages.map(message => message.text);
  const prContext = task.prContext ?? extractPrContext(threadTexts);

  logStep?.({
    stage: 'pr_review.context.fetch.done',
    message: 'Fetched Slack thread context.',
    data: { messages: threadMessages.length },
  });

  if (!prContext) {
    logStep?.({
      stage: 'pr_review.context.missing',
      message: 'PR context missing; asking for URL in thread and pausing.',
      level: 'WARN',
    });

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: 'Please include a GitHub PR URL in this thread. Format: `https://github.com/Newton-School/<repo>/pull/<number>`',
    });

    return {
      workflow: 'PR_REVIEW',
      status: 'PAUSED',
      message: 'Missing PR context; asked for PR URL in thread.',
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (prContext.owner !== config.allowedPrOrg) {
    logStep?.({
      stage: 'pr_review.guard.org_rejected',
      message: 'PR org is not allowed by policy.',
      level: 'WARN',
      data: {
        owner: prContext.owner,
        allowedOrg: config.allowedPrOrg,
      },
    });

    notifyDesktop(
      'Watchtower PR review skipped',
      `PR org ${prContext.owner} is not allowed. Only ${config.allowedPrOrg} is supported.`
    );
    return {
      workflow: 'PR_REVIEW',
      status: 'SKIPPED',
      message: 'PR org not allowed',
      notifyDesktop: true,
      slackPosted: false,
    };
  }

  const repoPath = mapRepoPath(config, prContext);
  if (!repoPath) {
    logStep?.({
      stage: 'pr_review.guard.repo_unmapped',
      message: 'PR repository is not mapped to a configured local path.',
      level: 'WARN',
      data: {
        owner: prContext.owner,
        repo: prContext.repo,
      },
    });

    notifyDesktop(
      'Watchtower unmapped PR repo',
      `No local repo mapping for ${prContext.owner}/${prContext.repo}; skipping auto execution.`
    );
    return {
      workflow: 'PR_REVIEW',
      status: 'SKIPPED',
      message: 'Repo unmapped; desktop notification only.',
      notifyDesktop: true,
      slackPosted: false,
    };
  }

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: 'Running PR review...',
  });

  logStep?.({
    stage: 'pr_review.slack.ack_posted',
    message: 'Posted PR review start acknowledgement to Slack thread.',
    data: { prUrl: prContext.url },
  });

  const githubToken = await resolveGithubTokenForCodex();

  logStep?.({
    stage: 'pr_review.github.auth_resolved',
    message: 'Resolved GitHub auth mode for Codex execution.',
    data: { tokenInjected: Boolean(githubToken) },
  });

  const prompt = `
You are executing Watchtower PR review automation.

Context:
- PR URL: ${prContext.url}
- Repository path: ${repoPath}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

Requirements:
1. Use the frontend-pr-review skill for analysis.
2. If findings exist, use comment-it skill to post inline GitHub review comments.
3. If no actionable findings, post exactly one PR comment: "No actionable findings. Good to go."
4. Return strict JSON matching schema with fields: status, summary, prUrl.
`.trim();

  const request: CodexRunRequest = {
    cwd: repoPath,
    prompt,
    timeoutMs: config.workflowTimeouts.prReviewMs,
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/pr-review-result.schema.json'),
    githubToken,
    onLog: logStep,
  };

  logStep?.({
    stage: 'pr_review.codex.start',
    message: 'Starting Codex PR review execution.',
    data: {
      repoPath,
      timeoutMs: config.workflowTimeouts.prReviewMs,
    },
  });

  const result = await runCodex(request);

  logStep?.({
    stage: 'pr_review.codex.finish',
    message: 'Codex PR review execution finished.',
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
      ? 'PR review timed out.'
      : `PR review failed (exit=${result.exitCode ?? 'unknown'}).`;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `${errorText} Check desktop notifications for details.`,
    });

    logStep?.({
      stage: 'pr_review.slack.failure_posted',
      message: 'Posted PR review failure status to Slack thread.',
      level: 'ERROR',
      data: {
        errorText,
      },
    });

    notifyDesktop('Watchtower PR review failed', `${errorText} thread=${task.event.threadTs}`);

    return {
      workflow: 'PR_REVIEW',
      status: 'FAILED',
      message: errorText,
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  const summary = String(result.parsedJson.summary ?? 'Review completed.');
  const prUrl = String(result.parsedJson.prUrl ?? prContext.url);

  logStep?.({
    stage: 'pr_review.result.parsed',
    message: 'Parsed PR review result payload.',
    data: {
      summary,
      prUrl,
    },
  });

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: `PR review completed. ${summary}\n${prUrl}`,
  });

  logStep?.({
    stage: 'pr_review.slack.success_posted',
    message: 'Posted PR review completion status to Slack thread.',
    data: {
      prUrl,
    },
  });

  return {
    workflow: 'PR_REVIEW',
    status: 'SUCCESS',
    message: summary,
    notifyDesktop: false,
    slackPosted: true,
    result: result.parsedJson,
  };
}
