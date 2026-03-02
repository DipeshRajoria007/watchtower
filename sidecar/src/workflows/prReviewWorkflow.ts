import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  NormalizedTask,
  PrContext,
  WorkflowResult,
} from '../types/contracts.js';
import { fetchThreadContext } from '../slack/threadContext.js';
import { extractPrContext } from '../router/intentParser.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { runCodex } from '../codex/runCodex.js';

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
}): Promise<WorkflowResult> {
  const { task, config, slack } = params;
  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs);
  const threadTexts = threadMessages.map(message => message.text);
  const prContext = task.prContext ?? extractPrContext(threadTexts);

  if (!prContext) {
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

  const prompt = `
You are executing Watchtower PR review automation.

Context:
- PR URL: ${prContext.url}
- Repository path: ${repoPath}

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
    githubToken: process.env[config.githubOwnerTokenEnv],
  };

  const result = await runCodex(request);

  if (!result.ok || !result.parsedJson) {
    const errorText = result.timedOut
      ? 'PR review timed out.'
      : `PR review failed (exit=${result.exitCode ?? 'unknown'}).`;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `${errorText} Check desktop notifications for details.`,
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

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: `PR review completed. ${summary}\n${prUrl}`,
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
