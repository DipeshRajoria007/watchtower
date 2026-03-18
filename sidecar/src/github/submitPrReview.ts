import type { AgentFinding } from '../agents/types.js';
import { logger } from '../logging/logger.js';

interface PrReviewComment {
  path: string;
  line: number;
  body: string;
}

type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

function determineReviewEvent(findings: AgentFinding[]): ReviewEvent {
  const hasCritical = findings.some(f => f.severity === 'critical');
  const hasHigh = findings.some(f => f.severity === 'high');
  if (hasCritical || hasHigh) return 'REQUEST_CHANGES';
  if (findings.length > 0) return 'COMMENT';
  return 'APPROVE';
}

function buildCommentBody(f: AgentFinding, role: string): string {
  const tag = `**[${role.toUpperCase()} — ${f.severity.toUpperCase()}]**`;
  const suggestion = f.suggestion ? `\n\n> 💡 **Suggestion:** ${f.suggestion}` : '';
  return `${tag} ${f.message}${suggestion}`;
}

export async function submitPrReview(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  findingsByRole: Array<{ role: string; findings: AgentFinding[] }>;
  summary: string;
  githubToken?: string;
}): Promise<{ submitted: boolean; event: ReviewEvent; commentsPosted: number }> {
  const { owner, repo, pullNumber, commitId, findingsByRole, summary, githubToken } = params;

  if (!githubToken) {
    logger.warn('No GitHub token available — skipping PR review submission');
    return { submitted: false, event: 'COMMENT', commentsPosted: 0 };
  }

  const allFindings = findingsByRole.flatMap(r => r.findings);
  const event = determineReviewEvent(allFindings);

  // Convert findings with file+line to inline comments
  const comments: PrReviewComment[] = [];
  for (const { role, findings } of findingsByRole) {
    for (const f of findings) {
      if (f.file && f.line && f.line > 0) {
        comments.push({
          path: f.file,
          line: f.line,
          body: buildCommentBody(f, role),
        });
      }
    }
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;

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
        event,
        body: summary,
        comments,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      logger.warn(
        { status: response.status, errorBody, owner, repo, pullNumber },
        'GitHub PR review submission failed — retrying without inline comments',
      );

      // Retry without inline comments (line numbers may be off for the commit)
      if (comments.length > 0) {
        const retryResponse = await fetch(url, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${githubToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            commit_id: commitId,
            event,
            body: summary,
            comments: [],
          }),
        });

        if (retryResponse.ok) {
          return { submitted: true, event, commentsPosted: 0 };
        }
      }

      return { submitted: false, event, commentsPosted: 0 };
    }

    return { submitted: true, event, commentsPosted: comments.length };
  } catch (error) {
    logger.warn({ error: String(error), owner, repo, pullNumber }, 'GitHub PR review submission threw');
    return { submitted: false, event, commentsPosted: 0 };
  }
}
