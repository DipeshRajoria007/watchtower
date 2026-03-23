import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import type { AgentFinding } from '../agents/types.js';
import { fetchThreadContext } from '../slack/threadContext.js';
import { extractPrContext } from '../router/intentParser.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile, profileForAgentRole } from '../codex/modelProfiles.js';
import { githubAuthModeHint, resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { submitPrReview } from '../github/submitPrReview.js';
import { buildPrReviewerPrompt, buildPrSecurityPrompt, buildPrPerformancePrompt } from '../agents/prReviewPrompts.js';
import type { PipelineStore } from '../agents/pipeline.js';
import { resolveWorkspace } from '../workspaces/workspaceManager.js';

const execFileAsync = promisify(execFile);

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

    const payload = (await response.json()) as {
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

interface PrMetadata {
  headSha?: string;
  headRef?: string;
  title?: string;
  body?: string;
}

async function fetchPrMetadata(params: {
  prContext: PrContext;
  githubToken?: string;
  logStep?: WorkflowStepLogger;
}): Promise<PrMetadata> {
  const { prContext, githubToken, logStep } = params;
  const url = `https://api.github.com/repos/${prContext.owner}/${prContext.repo}/pulls/${prContext.number}`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return {};
    const payload = (await response.json()) as Record<string, unknown>;
    const head = payload.head as Record<string, unknown> | undefined;
    return {
      headSha: typeof head?.sha === 'string' ? head.sha : undefined,
      headRef: typeof head?.ref === 'string' ? head.ref : undefined,
      title: typeof payload.title === 'string' ? payload.title : undefined,
      body: typeof payload.body === 'string' ? payload.body : undefined,
    };
  } catch (error) {
    logStep?.({
      stage: 'pr_review.metadata.error',
      message: `Failed to fetch PR metadata: ${String(error)}`,
      level: 'WARN',
    });
    return {};
  }
}

async function fetchPrDiff(params: { prContext: PrContext; githubToken?: string; maxChars?: number }): Promise<string> {
  const { prContext, githubToken, maxChars = 100_000 } = params;
  const url = `https://api.github.com/repos/${prContext.owner}/${prContext.repo}/pulls/${prContext.number}`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github.diff' };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return '';
    const diff = await response.text();
    if (diff.length > maxChars) {
      return diff.slice(0, maxChars) + '\n\n... [diff truncated — too large for full review]';
    }
    return diff;
  } catch {
    return '';
  }
}

async function checkoutPrBranch(repoPath: string, prNumber: number, logStep?: WorkflowStepLogger): Promise<boolean> {
  try {
    // Fetch the PR head ref and checkout
    await execFileAsync('git', ['fetch', 'origin', `pull/${prNumber}/head`], {
      cwd: repoPath,
      timeout: 60_000,
    });
    await execFileAsync('git', ['checkout', 'FETCH_HEAD'], {
      cwd: repoPath,
      timeout: 15_000,
    });
    logStep?.({ stage: 'pr_review.checkout.done', message: `Checked out PR #${prNumber} head in worktree.` });
    return true;
  } catch (error) {
    logStep?.({
      stage: 'pr_review.checkout.failed',
      message: `Failed to checkout PR branch: ${String(error)}`,
      level: 'WARN',
    });
    return false;
  }
}

function extractFindings(output: Record<string, unknown>): AgentFinding[] {
  const raw = output.findings;
  if (!Array.isArray(raw)) return [];
  return raw.map((f: Record<string, unknown>) => ({
    severity: (f.severity as AgentFinding['severity']) ?? 'info',
    category: (f.category as string) ?? 'general',
    message: (f.message as string) ?? '',
    file: f.file as string | undefined,
    line: f.line as number | undefined,
    suggestion: f.suggestion as string | undefined,
  }));
}

function formatSlackReviewSummary(
  findingsByRole: Array<{ role: string; findings: AgentFinding[] }>,
  prUrl: string,
  reviewEvent?: string,
): string {
  const allFindings = findingsByRole.flatMap(r => r.findings);
  if (allFindings.length === 0) {
    return `*PR Review Complete* — No actionable findings. Good to go. ✅\n${prUrl}`;
  }

  const bySeverity = new Map<string, Array<{ role: string; finding: AgentFinding }>>();
  for (const { role, findings } of findingsByRole) {
    for (const f of findings) {
      const list = bySeverity.get(f.severity) ?? [];
      list.push({ role, finding: f });
      bySeverity.set(f.severity, list);
    }
  }

  const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
  const emoji: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: 'ℹ️' };
  const lines: string[] = [];

  const verdict = reviewEvent === 'APPROVE' ? '✅' : reviewEvent === 'REQUEST_CHANGES' ? '🚫' : '💬';
  lines.push(`*PR Review Complete* — ${allFindings.length} finding(s) ${verdict}`);

  for (const severity of severityOrder) {
    const items = bySeverity.get(severity);
    if (!items || items.length === 0) continue;
    lines.push(
      `\n*${emoji[severity] ?? ''} ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${items.length})*`,
    );
    for (const { role, finding } of items) {
      const loc = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ''}\`` : '';
      lines.push(`• ${loc ? `${loc} — ` : ''}${finding.message} _[${role}]_`);
    }
  }

  lines.push(`\n${prUrl}`);
  return lines.join('\n');
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
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, resolvePrHeadSha, jobId: _jobId, logStep, signal } = params;

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
      `PR org ${prContext.owner} is not allowed. Only ${config.allowedPrOrg} is supported.`,
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
      `PR repo ${prContext.owner}/${prContext.repo} is outside supported scope.`,
    );
    return {
      workflow: 'PR_REVIEW',
      status: 'SKIPPED',
      message: 'PR repo out of scope; informed requester in thread.',
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  const baseRepoPath = mapRepoPath(config, prContext);
  if (!baseRepoPath) {
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
      `No local repo mapping for ${prContext.owner}/${prContext.repo}; skipping auto execution.`,
    );
    return {
      workflow: 'PR_REVIEW',
      status: 'SKIPPED',
      message: 'Repo unmapped; desktop notification only.',
      notifyDesktop: true,
      slackPosted: false,
    };
  }

  const repoPath = resolveWorkspace(baseRepoPath, task.event.threadTs);

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
    ? [`Active policy pack: ${policyPack.packName}`, ...policyPack.rules.map(rule => `- ${rule}`)].join('\n')
    : 'No explicit policy pack assigned for this channel.';

  // --- Multi-agent pipeline path ---
  if (config.multiAgentEnabled) {
    logStep?.({
      stage: 'pr_review.pipeline.start',
      message: 'Running PR review through parallel multi-agent pipeline.',
    });

    const threadContext = threadTexts.join('\n---\n');
    const pipelineStart = Date.now();

    // 1. Fetch PR metadata and diff
    const prMeta = await fetchPrMetadata({ prContext, githubToken, logStep });
    const prHeadSha = currentPrHeadSha ?? prMeta.headSha;

    const diff = await fetchPrDiff({ prContext, githubToken });
    if (!diff) {
      logStep?.({ stage: 'pr_review.diff.empty', message: 'PR diff is empty — cannot run review.', level: 'WARN' });
    }

    logStep?.({
      stage: 'pr_review.diff.fetched',
      message: `Fetched PR diff (${diff.length} chars).`,
      data: { diffChars: diff.length, prTitle: prMeta.title },
    });

    // 2. Checkout PR branch so agents see the actual PR code
    await checkoutPrBranch(repoPath, prContext.number, logStep);

    // 3. Build PR-specific prompts with diff included
    const reviewerPrompt = buildPrReviewerPrompt({
      diff,
      prTitle: prMeta.title,
      prBody: prMeta.body,
      threadContext,
      prContext,
      policyBlock,
    });
    const securityPrompt = buildPrSecurityPrompt({ diff, prTitle: prMeta.title, prContext });
    const performancePrompt = buildPrPerformancePrompt({ diff, prTitle: prMeta.title, prContext });

    // 4. Run all 3 review agents in parallel
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: 'Running reviewer, security, and performance checks in parallel...',
      })
      .catch(() => {});

    const reviewerProfile = profileForAgentRole('reviewer', getActiveBackendId());
    const securityProfile = profileForAgentRole('security', getActiveBackendId());
    const performanceProfile = profileForAgentRole('performance', getActiveBackendId());

    const schemaDir = path.resolve(process.cwd(), 'schemas');

    const perAgentTimeoutMs = Math.floor(config.prReviewTimeoutMs / 3);

    const [reviewerResult, securityResult, performanceResult] = await Promise.all([
      runCodex({
        cwd: repoPath,
        prompt: reviewerPrompt,
        outputSchemaPath: path.join(schemaDir, 'agent-reviewer-result.schema.json'),
        githubToken,
        ...reviewerProfile,
        timeoutMs: perAgentTimeoutMs,
        onLog: logStep,
      }),
      runCodex({
        cwd: repoPath,
        prompt: securityPrompt,
        outputSchemaPath: path.join(schemaDir, 'agent-security-result.schema.json'),
        githubToken,
        ...securityProfile,
        timeoutMs: perAgentTimeoutMs,
        onLog: logStep,
      }),
      runCodex({
        cwd: repoPath,
        prompt: performancePrompt,
        outputSchemaPath: path.join(schemaDir, 'agent-performance-result.schema.json'),
        githubToken,
        ...performanceProfile,
        timeoutMs: perAgentTimeoutMs,
        onLog: logStep,
      }),
    ]);

    // 5. Extract findings from each agent
    const findingsByRole: Array<{ role: string; findings: AgentFinding[] }> = [
      { role: 'reviewer', findings: extractFindings(reviewerResult.parsedJson ?? {}) },
      { role: 'security', findings: extractFindings(securityResult.parsedJson ?? {}) },
      { role: 'performance', findings: extractFindings(performanceResult.parsedJson ?? {}) },
    ];
    const allFindings = findingsByRole.flatMap(r => r.findings);

    const totalDurationMs = Date.now() - pipelineStart;
    logStep?.({
      stage: 'pr_review.pipeline.done',
      message: `Parallel PR review complete in ${Math.round(totalDurationMs / 1000)}s — ${allFindings.length} finding(s).`,
      data: {
        totalDurationMs,
        reviewer: { ok: reviewerResult.ok, findings: findingsByRole[0].findings.length },
        security: { ok: securityResult.ok, findings: findingsByRole[1].findings.length },
        performance: { ok: performanceResult.ok, findings: findingsByRole[2].findings.length },
      },
    });

    // 6. Submit formal GitHub PR review with inline comments
    let reviewEvent: string | undefined;
    if (prHeadSha) {
      const reviewSummaryForGh =
        allFindings.length > 0
          ? `Watchtower found ${allFindings.length} issue(s) in this PR.`
          : 'Watchtower review complete — no actionable findings. Good to go.';

      const reviewResult = await submitPrReview({
        owner: prContext.owner,
        repo: prContext.repo,
        pullNumber: prContext.number,
        commitId: prHeadSha,
        findingsByRole,
        summary: reviewSummaryForGh,
        githubToken,
      });

      reviewEvent = reviewResult.event;
      logStep?.({
        stage: 'pr_review.github_review.submitted',
        message: `GitHub PR review submitted: ${reviewResult.event} (${reviewResult.commentsPosted} inline comments).`,
        data: reviewResult,
      });
    }

    // 7. Post formatted summary to Slack
    const slackSummary = formatSlackReviewSummary(findingsByRole, prContext.url, reviewEvent);

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: slackSummary,
    });

    const hasCriticalOrHigh = allFindings.some(f => f.severity === 'critical' || f.severity === 'high');

    return {
      workflow: 'PR_REVIEW',
      status: hasCriticalOrHigh ? 'FAILED' : 'SUCCESS',
      message: slackSummary,
      notifyDesktop: false,
      slackPosted: true,
      result: {
        ...(prHeadSha ? { prHeadSha } : {}),
        prUrl: prContext.url,
        totalFindings: allFindings.length,
        reviewEvent,
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
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/pr-review-result.schema.json'),
    githubToken,
    ...highReasoningProfile(getActiveBackendId()),
    timeoutMs: config.prReviewTimeoutMs,
    onLog: logStep,
    signal,
  };

  logStep?.({
    stage: 'pr_review.codex.start',
    message: 'Starting Codex PR review execution with high-reasoning profile.',
    data: {
      repoPath,
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
