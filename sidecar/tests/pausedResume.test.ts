import { describe, expect, it } from 'vitest';
import { decidePausedResume } from '../src/router/pausedResume.js';

describe('decidePausedResume', () => {
  it('does not resume when no paused job exists in the thread', () => {
    const decision = decidePausedResume({
      pausedJob: undefined,
      eventText: 'https://github.com/Newton-School/newton-web/pull/123',
    });
    expect(decision.resume).toBe(false);
    expect(decision.reason).toBe('no_paused_job');
    expect(decision.paused).toBeUndefined();
  });

  it('resumes a paused PR_REVIEW when the reply carries a PR URL', () => {
    const paused = { id: 'job-1', workflow: 'PR_REVIEW' as const };
    const decision = decidePausedResume({
      pausedJob: paused,
      eventText: 'sorry, here it is: https://github.com/Newton-School/newton-web/pull/123',
    });
    expect(decision.resume).toBe(true);
    expect(decision.reason).toBe('pr_review_url_reply');
    expect(decision.paused).toEqual(paused);
  });

  it('does not resume a paused PR_REVIEW on a no-URL reply (small talk)', () => {
    const paused = { id: 'job-1', workflow: 'PR_REVIEW' as const };
    const decision = decidePausedResume({
      pausedJob: paused,
      eventText: 'thanks!',
    });
    expect(decision.resume).toBe(false);
    expect(decision.reason).toBe('pr_review_no_url_in_reply');
  });

  it('does not resume on a paused workflow whose resume is not yet wired', () => {
    const paused = { id: 'job-2', workflow: 'IMPLEMENTATION' as const };
    const decision = decidePausedResume({
      pausedJob: paused,
      eventText: 'looks good, please continue',
    });
    expect(decision.resume).toBe(false);
    expect(decision.reason).toBe('unhandled_workflow:IMPLEMENTATION');
  });
});
