import type { WorkflowIntent } from '../types/contracts.js';
import { extractPrContext } from './intentParser.js';

export interface PausedJobSummary {
  id: string;
  workflow: WorkflowIntent;
}

export interface PausedResumeDecision {
  resume: boolean;
  reason: string;
  paused?: PausedJobSummary;
}

/**
 * Decide whether a follow-up Slack reply in a paused-job's thread should be
 * treated as a resume signal — bypassing the @miniOG mention requirement that
 * processEvent normally enforces.
 *
 * A paused workflow that explicitly asked the user to reply in-thread (e.g.
 * PR_REVIEW asking for a missing PR URL) needs to be able to pick up that
 * reply even though the user didn't re-tag the bot. Without this, the
 * mention-detect gate silently drops the reply, leaving the user staring at
 * the bot's "drop the URL in this thread" prompt forever.
 *
 * Resume only fires when the reply carries the input the paused workflow
 * actually asked for — otherwise small talk in a paused thread would
 * spuriously resurrect the workflow.
 */
export function decidePausedResume(params: {
  pausedJob: PausedJobSummary | undefined;
  eventText: string;
}): PausedResumeDecision {
  const { pausedJob, eventText } = params;

  if (!pausedJob) {
    return { resume: false, reason: 'no_paused_job' };
  }

  if (pausedJob.workflow === 'PR_REVIEW') {
    if (extractPrContext([eventText])) {
      return { resume: true, reason: 'pr_review_url_reply', paused: pausedJob };
    }
    return { resume: false, reason: 'pr_review_no_url_in_reply' };
  }

  return { resume: false, reason: `unhandled_workflow:${pausedJob.workflow}` };
}
