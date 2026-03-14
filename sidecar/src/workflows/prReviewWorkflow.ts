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
import type { JobStore } from '../state/jobStore.js';
import { fetchThreadContext } from '../slack/threadContext.js';
import { extractPrContext } from '../router/intentParser.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { githubAuthModeHint, resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { runAgentPipeline } from '../agents/pipeline.js';
import type { PipelineStore } from '../agents/pipeline.js';
import type { PipelineConfig } from '../agents/types.js';

const SUPPORTED_PR_REPOS = ['newton-web', 'newton-api'] as const;

function mapRepoPath(config: AppConfig, pr: PrContext): string | null {
  if (pr.repo === 'newton-web') {
    return config.repoPaths.newtonWeb;
  }
  if (pr.repo === 'newton-api') {
    return config.repoPaths.newtonApi;
  }
  return null;
}

async function fetchPrHeadSha(params: {
  prContext: PrContext;
  githubToken?: string;
  logStep?: WorkflowStepLogger;
}): Promise<string | undefined> {
  const { prContext, githubToken, logStep } = params;
  const url = `https://api.github.com/repos/${prContext.owner}/${prContext.repo}/pulls/${prContext.number}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      logStep?.({
        stage: 'pr_review.head_sha.fetch_failed',
        message: 'Failed to fetch PR head SHA from GitHub API.',
        level: 'WARN',
        data: {
          status: response.status,
          statusText: response.statusText,
        },
      });
      return undefined;
    }

    const payload = await response.json() as {
      head?: {
        sha?: unknown;
      };
    };

    return typeof payload.head?.sha === 'string' ? payload.head.sha : undefined;
  } catch (error) {
    logStep?.({
      stage: 'pr_review.head_sha.fetch_error',
      message: 'Error while fetching PR head SHA from GitHub API.',
      level: 'WARN',
      data: {
        error: String(error),
      },
    });
    return undefined;
  }
}

const NO_NEW_CHANGES_TEXT =
  'No new commits since the last review. Same diff, same verdict. Push an update and I will rerun.';

function buildOutOfScopePrReply(userId: string, allowedPrOrg: string): string {
  return `<@${userId}> this PR is outside supported review scope. I can review \`${allowedPrOrg}/newton-web\` and \`${allowedPrOrg}/newton-api\`.`;
}

export async function runPrReviewWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: Pick<JobStore, 'findLatestReviewedPrHeadSha' | 'getChannelPolicyPack'> & Partial<PipelineStore>;
  resolvePrHeadSha?: (input: {
    prContext: PrContext;
    githubToken?: string;
    logStep?: WorkflowStepLogger;
  }) => Promise<string | undefined>;
  jobId?: string;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, resolvePrHeadSha, jobId, logStep } = params;

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
      text: `<@${task.event.userId}> drop the GitHub PR URL in this thread and i will pick it up. Format: \`https://github.com/Newton-School/<repo>/pull/<number>\``,
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

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: buildOutOfScopePrReply(task.event.userId, config.allowedPrOrg),
    });

    notifyDesktop(
      'Watchtower PR review skipped',
      `PR org ${prContext.owner} is not allowed. Only ${config.allowedPrOrg} is supported.`
    );
    return {
      workflow: 'PR_REVIEW',
      status: 'SKIPPED',
      message: 'PR org not allowed; informed requester in thread.',
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  if (!SUPPORTED_PR_REPOS.includes(prContext.repo as (typeof SUPPORTED_PR_REPOS)[number])) {
    logStep?.({
      stage: 'pr_review.guard.repo_out_of_scope',
      message: 'PR repository is outside of supported review scope.',
      level: 'WARN',
      data: {
        owner: prContext.owner,
        repo: prContext.repo,
        supportedRepos: [...SUPPORTED_PR_REPOS],
      },
    });

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: buildOutOfScopePrReply(task.event.userId, config.allowedPrOrg),
    });

    notifyDesktop(
      'Watchtower PR review skipped',
      `PR repo ${prContext.owner}/${prContext.repo} is outside supported scope.`
    );
    return {
      workflow: 'PR_REVIEW',
      status: 'SKIPPED',
      message: 'PR repo out of scope; informed requester in thread.',
      notifyDesktop: true,
      slackPosted: true,
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

  const githubToken = await resolveGithubTokenForCodex();

  logStep?.({
    stage: 'pr_review.github.auth_resolved',
    message: 'Resolved GitHub auth mode for Codex execution.',
    data: { tokenInjected: Boolean(githubToken) },
  });

  const headShaResolver = resolvePrHeadSha ?? fetchPrHeadSha;
  const currentPrHeadSha = await headShaResolver({
    prContext,
    githubToken,
    logStep,
  });

  if (currentPrHeadSha) {
    logStep?.({
      stage: 'pr_review.head_sha.fetched',
      message: 'Fetched current PR head SHA.',
      data: {
        prHeadSha: currentPrHeadSha,
      },
    });

    const previous = store?.findLatestReviewedPrHeadSha({
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      prUrl: prContext.url,
    });

    if (previous && previous.prHeadSha === currentPrHeadSha) {
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: NO_NEW_CHANGES_TEXT,
      });

      logStep?.({
        stage: 'pr_review.no_new_changes',
        message: 'Skipped PR review because there are no new commits since last successful review.',
        level: 'INFO',
        data: {
          prHeadSha: currentPrHeadSha,
          previousJobId: previous.jobId,
          previousReviewedAt: previous.updatedAt,
        },
      });

      return {
        workflow: 'PR_REVIEW',
        status: 'SKIPPED',
        message: 'No new changes since last review.',
        notifyDesktop: false,
        slackPosted: true,
        result: {
          prUrl: prContext.url,
          prHeadSha: currentPrHeadSha,
          previousReviewedAt: previous.updatedAt,
        },
      };
    }
  }

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: 'PR review in progress. I will drop findings here shortly.',
  });

  logStep?.({
    stage: 'pr_review.slack.ack_posted',
    message: 'Posted PR review start acknowledgement to Slack thread.',
    data: { prUrl: prContext.url },
  });

  const policyPack = store?.getChannelPolicyPack(task.event.channelId);
  const policyBlock = policyPack
    ? [
        `Active policy pack: ${policyPack.packName}`,
        ...policyPack.rules.map(rule => `- ${rule}`),
      ].join('\n')
    : 'No explicit policy pack assigned for this channel.';

  // --- Multi-agent pipeline path ---
  if (config.multiAgentEnabled) {
    logStep?.({
      stage: 'pr_review.pipeline.start',
      message: 'Running PR review through multi-agent pipeline.',
    });

    const pipelineConfig: PipelineConfig = {
      agents: ['planner', 'reviewer', 'security', 'performance'],
      maxRetryLoops: 0,
      perAgentTimeoutMs: config.workflowTimeouts.prReviewMs / 4,
      totalTimeoutMs: config.workflowTimeouts.prReviewMs,
      abortOnCriticalFinding: true,
      slackProgressUpdates: true,
    };

    const threadContext = threadTexts.join('\n---\n');
    const pipelineResult = await runAgentPipeline({
      ctx: {
        workflowIntent: 'PR_REVIEW',
        task,
        config,
        repoPath: repoPath!,
        githubToken,
        threadContext,
        prContext,
        previousSteps: [],
        pipelineConfig,
        policyPack: policyPack ? { packName: policyPack.packName, rules: policyPack.rules } : undefined,
      },
      slack,
      logStep: logStep ?? (() => {}),
      store: store?.createPipelineRun && store?.updatePipelineRun ? store as PipelineStore : undefined,
      jobId,
    });

    const findings = pipelineResult.aggregatedFindings;
    const summaryParts: string[] = [];
    for (const step of pipelineResult.steps) {
      const tag = `[${step.role.charAt(0).toUpperCase() + step.role.slice(1)}]`;
      for (const f of step.findings) {
        summaryParts.push(`${tag} ${f.severity}: ${f.message}`);
      }
    }

    const summaryText = summaryParts.length > 0
      ? `Multi-agent PR review complete. ${findings.length} finding(s):\n${summaryParts.join('\n')}`
      : 'Multi-agent PR review complete. No actionable findings. Good to go.';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `${summaryText}\n${prContext.url}`,
    });

    return {
      workflow: 'PR_REVIEW',
      status: pipelineResult.finalStatus === 'passed' ? 'SUCCESS' : 'FAILED',
      message: summaryText,
      notifyDesktop: false,
      slackPosted: true,
      result: {
        ...( currentPrHeadSha ? { prHeadSha: currentPrHeadSha } : {}),
        prUrl: prContext.url,
        pipelineStatus: pipelineResult.finalStatus,
        totalFindings: findings.length,
      },
    };
  }

  // --- Single-agent path (legacy) ---
  const prompt = `
${buildMentionSystemPrompt({ task, workflow: 'PR_REVIEW' })}

You are executing Watchtower PR review automation.

Context:
- PR URL: ${prContext.url}
- Repository path: ${repoPath}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}
- Policy pack:
${policyBlock}

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
    ...highReasoningProfile(getActiveBackendId()),
    onLog: logStep,
  };

  logStep?.({
    stage: 'pr_review.codex.start',
    message: 'Starting Codex PR review execution with high-reasoning profile.',
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
      text: `${errorText} I could not close this loop right now. Check desktop notifications for details.`,
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
    text: `PR review done. ${summary}\n${prUrl}`,
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
    result: {
      ...result.parsedJson,
      ...(currentPrHeadSha ? { prHeadSha: currentPrHeadSha } : {}),
    },
  };
}
