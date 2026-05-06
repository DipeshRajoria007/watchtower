import type { AgentFinding } from '../agents/types.js';
import { logger } from '../logging/logger.js';
import type { WorkflowStepLogger } from '../types/contracts.js';
import { hasFileInDiff, isAnchorInDiff, parseDiffHunks, type HunkIndex } from './diffHunks.js';

const TRANSIENT_RETRY_DELAY_MS = 1500;
const ERROR_BODY_LOG_LIMIT = 1000;

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncateErrorBody(body: string): string {
  if (body.length <= ERROR_BODY_LOG_LIMIT) return body;
  return `${body.slice(0, ERROR_BODY_LOG_LIMIT)}…[truncated ${body.length - ERROR_BODY_LOG_LIMIT} chars]`;
}

function logGithubRejection(
  logStep: WorkflowStepLogger | undefined,
  attempt: string,
  status: number,
  errorBody: string,
  context: { owner: string; repo: string; pullNumber: number },
): void {
  const truncated = truncateErrorBody(errorBody);
  logger.warn({ status, errorBody: truncated, attempt, ...context }, 'GitHub PR review submission rejected');
  logStep?.({
    level: 'WARN',
    stage: 'pr_review.github_review.rejected',
    message: `GitHub rejected ${attempt} (HTTP ${status}).`,
    data: { attempt, status, errorBody: truncated, ...context },
  });
}

function logGithubThrew(
  logStep: WorkflowStepLogger | undefined,
  attempt: string,
  error: unknown,
  context: { owner: string; repo: string; pullNumber: number },
): void {
  const message = String(error);
  logger.warn({ error: message, attempt, ...context }, 'GitHub PR review submission threw');
  logStep?.({
    level: 'WARN',
    stage: 'pr_review.github_review.threw',
    message: `GitHub PR review submission threw on ${attempt}: ${message}`,
    data: { attempt, error: message, ...context },
  });
}

async function postReviewOnce(url: string, githubToken: string, payload: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

interface PrReviewComment {
  path: string;
  line: number;
  body: string;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
export type PrReviewSubmissionMode = 'inline' | 'summary_only' | 'skipped';
export type PrReviewFallbackReason = 'missing_location' | 'github_rejected_comments' | 'no_token';

export interface SubmitPrReviewResult {
  submitted: boolean;
  event: ReviewEvent;
  /** Inline comments we attempted to post in the batched review body. */
  attemptedComments: number;
  /** Inline comments GitHub actually accepted. */
  commentsPosted: number;
  /**
   * Findings that had a file+line but the line wasn't inside a diff hunk;
   * they were filtered out before the review POST so we don't trip GitHub's
   * all-or-nothing validation.
   */
  droppedOutsideDiff: number;
  /** File-level follow-up POSTs attempted after the review submission. */
  fileLevelAttempted: number;
  /** File-level follow-ups GitHub accepted. */
  fileLevelPosted: number;
  submissionMode: PrReviewSubmissionMode;
  fallbackReason?: PrReviewFallbackReason;
}

function determineReviewEvent(findings: AgentFinding[]): ReviewEvent {
  if (findings.length > 0) return 'COMMENT';
  return 'APPROVE';
}

function buildCommentBody(f: AgentFinding, role: string): string {
  const tag = `**[${role.toUpperCase()} — ${f.severity.toUpperCase()}]**`;
  const suggestion = f.suggestion ? `\n\n> 💡 **Suggestion:** ${f.suggestion}` : '';
  return `${tag} ${f.message}${suggestion}`;
}

interface FileLevelFinding {
  path: string;
  body: string;
}

/**
 * Split findings into inline candidates, file-level candidates, and drops.
 * When `hunkIndex` is provided, an inline candidate is only kept if its
 * (file, line) is inside a diff hunk; otherwise GitHub will 422 the whole
 * review batch. File-level candidates are kept when the file itself appears
 * in the diff (even if no specific line is given).
 */
function classifyFindings(
  findingsByRole: Array<{ role: string; findings: AgentFinding[] }>,
  hunkIndex: HunkIndex | undefined,
): {
  inlineComments: PrReviewComment[];
  fileLevelFindings: FileLevelFinding[];
  droppedOutsideDiff: number;
} {
  const inlineComments: PrReviewComment[] = [];
  const fileLevelFindings: FileLevelFinding[] = [];
  let droppedOutsideDiff = 0;

  for (const { role, findings } of findingsByRole) {
    for (const f of findings) {
      const hasLine = typeof f.line === 'number' && f.line > 0;
      if (!f.file) continue;

      if (hasLine) {
        if (!hunkIndex || isAnchorInDiff(hunkIndex, f.file, f.line as number)) {
          inlineComments.push({
            path: f.file,
            line: f.line as number,
            body: buildCommentBody(f, role),
          });
        } else {
          droppedOutsideDiff++;
        }
        continue;
      }

      // File-only finding. Only post as a file-level comment if the file
      // itself is in the diff — otherwise there's nothing to anchor to.
      if (!hunkIndex || hasFileInDiff(hunkIndex, f.file)) {
        fileLevelFindings.push({
          path: f.file,
          body: buildCommentBody(f, role),
        });
      }
    }
  }

  return { inlineComments, fileLevelFindings, droppedOutsideDiff };
}

async function postFileLevelComments(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  findings: FileLevelFinding[];
  githubToken: string;
}): Promise<{ attempted: number; posted: number }> {
  const { owner, repo, pullNumber, commitId, findings, githubToken } = params;
  if (findings.length === 0) return { attempted: 0, posted: 0 };

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/comments`;
  let posted = 0;

  for (const f of findings) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${githubToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          commit_id: commitId,
          path: f.path,
          body: f.body,
          subject_type: 'file',
        }),
      });
      if (response.ok) {
        posted++;
      } else {
        const errorBody = await response.text().catch(() => '');
        logger.warn(
          { status: response.status, errorBody, owner, repo, pullNumber, path: f.path },
          'File-level PR comment rejected by GitHub',
        );
      }
    } catch (err) {
      logger.warn(
        { error: String(err), owner, repo, pullNumber, path: f.path },
        'File-level PR comment threw during submission',
      );
    }
  }

  return { attempted: findings.length, posted };
}

export async function submitPrReview(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  findingsByRole: Array<{ role: string; findings: AgentFinding[] }>;
  summary: string;
  githubToken?: string;
  /**
   * Raw unified-diff text for the PR as returned by GitHub's .diff endpoint.
   * When present, inline comment candidates are validated against hunk
   * ranges so we never hand GitHub a batch it'll reject wholesale, and
   * file-only findings are posted as `subject_type: 'file'` follow-ups.
   */
  prDiff?: string;
  /**
   * Optional workflow step logger. When provided, GitHub rejection details
   * (HTTP status + truncated error body) are persisted to job_logs so
   * post-mortems can read the exact reason out of SQLite instead of
   * grepping process stdout.
   */
  logStep?: WorkflowStepLogger;
}): Promise<SubmitPrReviewResult> {
  const { owner, repo, pullNumber, commitId, findingsByRole, summary, githubToken, prDiff, logStep } = params;
  const errorContext = { owner, repo, pullNumber };

  const allFindings = findingsByRole.flatMap(r => r.findings);
  const event = determineReviewEvent(allFindings);
  const hunkIndex = prDiff ? parseDiffHunks(prDiff) : undefined;

  const { inlineComments, fileLevelFindings, droppedOutsideDiff } = classifyFindings(findingsByRole, hunkIndex);
  const attemptedComments = inlineComments.length;
  const missingLocationFallback =
    allFindings.length > 0 && attemptedComments === 0 && fileLevelFindings.length === 0
      ? 'missing_location'
      : undefined;

  if (!githubToken) {
    logger.warn('No GitHub token available — skipping PR review submission');
    return {
      submitted: false,
      event,
      attemptedComments,
      commentsPosted: 0,
      droppedOutsideDiff,
      fileLevelAttempted: fileLevelFindings.length,
      fileLevelPosted: 0,
      submissionMode: 'skipped',
      fallbackReason: 'no_token',
    };
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;
  const fullPayload = { commit_id: commitId, event, body: summary, comments: inlineComments };
  const bodyOnlyPayload = { commit_id: commitId, event, body: summary, comments: [] };

  try {
    const response = await postReviewOnce(url, githubToken, fullPayload);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      logGithubRejection(logStep, 'review POST with inline comments', response.status, errorBody, errorContext);

      // Last-resort retry: drop inline comments entirely. This only kicks
      // in when pre-validation wasn't enough (e.g., diff drift because a
      // new commit landed between agents running and us POSTing). We try
      // body-only once, then once more after a short backoff if the second
      // attempt hits a transient 5xx / 429 — those have killed reviews in
      // the wild even though the inline-comment rejection was deterministic.
      if (inlineComments.length > 0) {
        let retryResponse = await postReviewOnce(url, githubToken, bodyOnlyPayload);

        if (!retryResponse.ok && isTransientStatus(retryResponse.status)) {
          const retryErrorBody = await retryResponse.text().catch(() => '');
          logGithubRejection(
            logStep,
            'body-only retry #1 (transient, will retry)',
            retryResponse.status,
            retryErrorBody,
            errorContext,
          );
          await delay(TRANSIENT_RETRY_DELAY_MS);
          retryResponse = await postReviewOnce(url, githubToken, bodyOnlyPayload);
        }

        if (retryResponse.ok) {
          const fileLevel = await postFileLevelComments({
            owner,
            repo,
            pullNumber,
            commitId,
            findings: fileLevelFindings,
            githubToken,
          });
          return {
            submitted: true,
            event,
            attemptedComments,
            commentsPosted: 0,
            droppedOutsideDiff,
            fileLevelAttempted: fileLevel.attempted,
            fileLevelPosted: fileLevel.posted,
            submissionMode: 'summary_only',
            fallbackReason: 'github_rejected_comments',
          };
        }

        const finalRetryBody = await retryResponse.text().catch(() => '');
        logGithubRejection(logStep, 'body-only retry (final)', retryResponse.status, finalRetryBody, errorContext);
      }

      return {
        submitted: false,
        event,
        attemptedComments,
        commentsPosted: 0,
        droppedOutsideDiff,
        fileLevelAttempted: fileLevelFindings.length,
        fileLevelPosted: 0,
        submissionMode: 'skipped',
        fallbackReason: inlineComments.length > 0 ? 'github_rejected_comments' : missingLocationFallback,
      };
    }

    const fileLevel = await postFileLevelComments({
      owner,
      repo,
      pullNumber,
      commitId,
      findings: fileLevelFindings,
      githubToken,
    });

    return {
      submitted: true,
      event,
      attemptedComments,
      commentsPosted: inlineComments.length,
      droppedOutsideDiff,
      fileLevelAttempted: fileLevel.attempted,
      fileLevelPosted: fileLevel.posted,
      submissionMode: inlineComments.length > 0 ? 'inline' : 'summary_only',
      fallbackReason: missingLocationFallback,
    };
  } catch (error) {
    logGithubThrew(logStep, 'review POST', error, errorContext);
    return {
      submitted: false,
      event,
      attemptedComments,
      commentsPosted: 0,
      droppedOutsideDiff,
      fileLevelAttempted: fileLevelFindings.length,
      fileLevelPosted: 0,
      submissionMode: 'skipped',
      fallbackReason: missingLocationFallback,
    };
  }
}
