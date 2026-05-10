import { describe, expect, it } from 'vitest';
import { decidePausedResume } from '../src/router/pausedResume.js';

describe('decidePausedResume', () => {
  it('does not resume when no paused job exists in the thread', () => {
    const decision = decidePausedResume({
      pausedJob: undefined,
      pauseSignal: undefined,
      eventText: 'https://github.com/Newton-School/newton-web/pull/123',
    });
    expect(decision.resume).toBe(false);
    expect(decision.reason).toBe('no_paused_job');
    expect(decision.paused).toBeUndefined();
  });

  it('resumes a paused PR_REVIEW-awaiting-URL when the reply carries a PR URL', () => {
    const paused = { id: 'job-1', workflow: 'PR_REVIEW' as const };
    const decision = decidePausedResume({
      pausedJob: paused,
      pauseSignal: 'pr_review_awaiting_url',
      eventText: 'sorry, here it is: https://github.com/Newton-School/newton-web/pull/123',
    });
    expect(decision.resume).toBe(true);
    expect(decision.reason).toBe('pr_review_url_reply');
    expect(decision.paused).toEqual(paused);
  });

  it('resumes regardless of jobs.workflow column when the pause signal matches', () => {
    // Owner-mention work lands in jobs.workflow=OWNER_AUTOPILOT even when the
    // classifier later routed it to PR_REVIEW. Resume must still fire.
    const paused = { id: 'job-1b', workflow: 'OWNER_AUTOPILOT' as const };
    const decision = decidePausedResume({
      pausedJob: paused,
      pauseSignal: 'pr_review_awaiting_url',
      eventText: 'https://github.com/Newton-School/newton-api/pull/42',
    });
    expect(decision.resume).toBe(true);
    expect(decision.reason).toBe('pr_review_url_reply');
    expect(decision.paused).toEqual(paused);
  });

  it('does not resume on a no-URL reply even when pause signal indicates awaiting-URL', () => {
    const paused = { id: 'job-1', workflow: 'PR_REVIEW' as const };
    const decision = decidePausedResume({
      pausedJob: paused,
      pauseSignal: 'pr_review_awaiting_url',
      eventText: 'thanks!',
    });
    expect(decision.resume).toBe(false);
    expect(decision.reason).toBe('pr_review_no_url_in_reply');
  });

  it('does not resume when pause signal is unknown (paused for some other reason)', () => {
    const paused = { id: 'job-2', workflow: 'IMPLEMENTATION' as const };
    const decision = decidePausedResume({
      pausedJob: paused,
      pauseSignal: undefined,
      eventText: 'looks good, please continue',
    });
    expect(decision.resume).toBe(false);
    expect(decision.reason).toBe('unhandled_pause_signal:unknown');
  });
});
