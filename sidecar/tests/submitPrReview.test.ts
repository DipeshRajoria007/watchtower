import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { submitPrReview } from '../src/github/submitPrReview.js';
import type { AgentFinding } from '../src/agents/types.js';

const originalFetch = globalThis.fetch;

describe('submitPrReview', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const baseFinding = (severity: AgentFinding['severity'], file?: string, line?: number): AgentFinding => ({
    severity,
    category: 'test',
    message: `Test ${severity} finding`,
    file,
    line,
  });

  it('submits REQUEST_CHANGES when critical findings exist', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'security', findings: [baseFinding('critical', 'src/auth.ts', 10)] }],
      summary: 'Found critical issue',
      githubToken: 'ghp_test',
    });

    expect(result.submitted).toBe(true);
    expect(result.event).toBe('REQUEST_CHANGES');
    expect(result.attemptedComments).toBe(1);
    expect(result.commentsPosted).toBe(1);
    expect(result.submissionMode).toBe('inline');
    expect(result.fallbackReason).toBeUndefined();

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.event).toBe('REQUEST_CHANGES');
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].path).toBe('src/auth.ts');
    expect(body.comments[0].line).toBe(10);
  });

  it('submits REQUEST_CHANGES when high findings exist', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('high', 'src/api.ts', 42)] }],
      summary: 'High severity issue',
      githubToken: 'ghp_test',
    });

    expect(result.event).toBe('REQUEST_CHANGES');
  });

  it('submits COMMENT when only medium/low findings exist', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('medium', 'src/utils.ts', 5)] }],
      summary: 'Medium issue',
      githubToken: 'ghp_test',
    });

    expect(result.event).toBe('COMMENT');
    expect(result.submissionMode).toBe('inline');
  });

  it('submits APPROVE when no findings exist', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [] }],
      summary: 'No issues',
      githubToken: 'ghp_test',
    });

    expect(result.event).toBe('APPROVE');
    expect(result.submissionMode).toBe('summary_only');
  });

  it('excludes findings without file/line from inline comments', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [
        {
          role: 'reviewer',
          findings: [
            baseFinding('medium', 'src/a.ts', 10),
            baseFinding('medium'), // no file/line
            baseFinding('low', 'src/b.ts', 0), // line 0 excluded
          ],
        },
      ],
      summary: 'Mixed',
      githubToken: 'ghp_test',
    });

    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as string);
    expect(result.attemptedComments).toBe(1);
    expect(result.commentsPosted).toBe(1);
    expect(result.submissionMode).toBe('inline');
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].path).toBe('src/a.ts');
  });

  it('returns summary_only with missing_location fallback when findings are not line-attachable', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('medium'), baseFinding('low', 'src/a.ts', 0)] }],
      summary: 'Summary only',
      githubToken: 'ghp_test',
    });

    expect(result.submitted).toBe(true);
    expect(result.attemptedComments).toBe(0);
    expect(result.commentsPosted).toBe(0);
    expect(result.submissionMode).toBe('summary_only');
    expect(result.fallbackReason).toBe('missing_location');

    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as string);
    expect(body.comments).toHaveLength(0);
  });

  it('returns submitted false when no GitHub token', async () => {
    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('high', 'src/a.ts', 4)] }],
      summary: 'Test',
      githubToken: undefined,
    });

    expect(result.submitted).toBe(false);
    expect(result.attemptedComments).toBe(1);
    expect(result.submissionMode).toBe('skipped');
    expect(result.fallbackReason).toBe('no_token');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('retries without inline comments when API rejects', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response('Validation Failed', { status: 422 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('medium', 'src/a.ts', 999)] }],
      summary: 'Retry test',
      githubToken: 'ghp_test',
    });

    expect(result.submitted).toBe(true);
    expect(result.attemptedComments).toBe(1);
    expect(result.commentsPosted).toBe(0);
    expect(result.submissionMode).toBe('summary_only');
    expect(result.fallbackReason).toBe('github_rejected_comments');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    // Second call should have empty comments
    const retryBody = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[1][1]?.body as string);
    expect(retryBody.comments).toHaveLength(0);
  });

  it('handles fetch errors gracefully', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('network error'));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [] }],
      summary: 'Test',
      githubToken: 'ghp_test',
    });

    expect(result.submitted).toBe(false);
    expect(result.submissionMode).toBe('skipped');
  });
});
