import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-store-')), 'watchtower.db');
}

describe('jobStore', () => {
  it('dedupes events and dedupe keys', () => {
    const dbPath = tempDbPath();
    const store = new JobStore(dbPath);

    expect(store.hasEvent('event-1')).toBe(false);
    store.recordEvent('event-1', 'C1', '123');
    expect(store.hasEvent('event-1')).toBe(true);

    expect(store.hasDedupeKey('C1:123:PR_REVIEW')).toBe(false);
    store.createJob({
      id: 'job-1',
      eventId: 'event-1',
      dedupeKey: 'C1:123:PR_REVIEW',
      workflow: 'PR_REVIEW',
      channelId: 'C1',
      threadTs: '123',
      payload: { foo: 'bar' },
    });
    expect(store.hasDedupeKey('C1:123:PR_REVIEW')).toBe(true);

    store.markJob('job-1', 'SUCCESS', {
      result: {
        prUrl: 'https://github.com/Newton-School/newton-web/pull/9999',
        prHeadSha: 'abc123',
      },
    });

    const previousHead = store.findLatestReviewedPrHeadSha({
      channelId: 'C1',
      threadTs: '123',
      prUrl: 'https://github.com/Newton-School/newton-web/pull/9999',
    });
    expect(previousHead?.prHeadSha).toBe('abc123');

    store.appendJobLog({
      jobId: 'job-1',
      stage: 'intake.received',
      message: 'Slack event accepted for processing.',
      data: { eventId: 'event-1' },
    });

    const logs = store.listJobLogs('job-1');
    expect(logs).toHaveLength(1);
    expect(logs[0].stage).toBe('intake.received');
    expect(logs[0].level).toBe('INFO');

    const resolved = store.resolveJobId('job-');
    expect(resolved).toBe('job-1');

    const tail = store.listJobLogsTail('job-1', 5);
    expect(tail).toHaveLength(1);
    expect(tail[0].stage).toBe('intake.received');

    const jobSummary = store.getJobSummary('job-1');
    expect(jobSummary?.workflow).toBe('PR_REVIEW');
    expect(jobSummary?.status).toBe('SUCCESS');

    const latest = store.latestJobForThread('C1', '123');
    expect(latest?.workflow).toBe('PR_REVIEW');

    store.saveIntentCorrection({
      channelId: 'C1',
      userId: 'U1',
      phraseKey: 'review this pr again',
      correctedIntent: 'PR_REVIEW',
    });
    expect(
      store.findIntentCorrection({
        channelId: 'C1',
        userId: 'U1',
        phraseKey: 'review this pr again',
      }),
    ).toBe('PR_REVIEW');

    store.setPersonalityProfile({
      scope: 'user',
      scopeId: 'U1',
      mode: 'normal',
      source: 'test',
    });
    expect(
      store.getPersonalityMode({
        channelId: 'C1',
        userId: 'U1',
      }),
    ).toBe('normal');
    expect(
      store.getPersonalityProfile({
        scope: 'user',
        scopeId: 'U1',
      }),
    ).toBe('normal');

    store.recordLearningSignal({
      jobId: 'job-1',
      eventId: 'event-1',
      channelId: 'C1',
      userId: 'U1',
      workflow: 'PR_REVIEW',
      intent: 'PR_REVIEW',
      status: 'SUCCESS',
      correctionApplied: false,
    });

    const learning = store.getDevLearningSnapshot();
    expect(learning.signals24h).toBeGreaterThanOrEqual(1);
    expect(learning.personalityProfiles).toBeGreaterThanOrEqual(1);

    const heat = store.getDevChannelHeat(5);
    expect(heat.length).toBeGreaterThanOrEqual(1);
    expect(heat[0].channelId).toBe('C1');

    const mission = store.upsertMissionStart({
      channelId: 'C1',
      threadTs: '123',
      goal: 'stabilize checkout flow',
      ownerUserId: 'U1',
    });
    expect(mission.status).toBe('ACTIVE');

    const missionState = store.getMissionThread({
      channelId: 'C1',
      threadTs: '123',
    });
    expect(missionState?.goal).toBe('stabilize checkout flow');
    expect(missionState?.status).toBe('ACTIVE');

    const swarm = store.startMissionSwarmRun({
      channelId: 'C1',
      threadTs: '123',
      requestedBy: 'U1',
    });
    expect(swarm?.roles).toContain('planner');

    const missionAfterSwarm = store.getMissionThread({
      channelId: 'C1',
      threadTs: '123',
    });
    expect(missionAfterSwarm?.status).toBe('RUNNING');
    expect(missionAfterSwarm?.progress).toContain('Swarm');

    store.setTrustPolicy({
      targetType: 'channel',
      targetId: 'C1',
      trustLevel: 'execute',
      updatedBy: 'U1',
    });
    const trust = store.getTrustPolicy({
      targetType: 'channel',
      targetId: 'C1',
    });
    expect(trust?.trustLevel).toBe('execute');
    expect(trust?.updatedBy).toBe('U1');

    const replay = store.createReplayRequest({
      sourceJobId: 'job-1',
      mode: 'replay',
      requestedBy: 'U1',
      channelId: 'C1',
      threadTs: '123',
    });
    expect(replay.status).toBe('QUEUED');
    expect(replay.requestId.startsWith('replay:')).toBe(true);

    store.recordReactionFeedback({
      eventId: 'reaction-1',
      channelId: 'C1',
      threadTs: '123',
      userId: 'U2',
      reaction: 'thumbsup',
      sentiment: 1,
    });
    store.recordReactionFeedback({
      eventId: 'reaction-2',
      channelId: 'C1',
      threadTs: '123',
      userId: 'U3',
      reaction: 'thumbsdown',
      sentiment: -1,
    });
    const feedback = store.getReactionFeedbackSnapshot('C1');
    expect(feedback.positive).toBeGreaterThanOrEqual(1);
    expect(feedback.negative).toBeGreaterThanOrEqual(1);

    store.registerSkill({
      name: 'frontend-pr-review',
      path: '/tmp/skills/frontend-pr-review/SKILL.md',
      version: '2026-03-04T00:00:00.000Z',
    });
    const skill = store.getSkill('frontend-pr-review');
    expect(skill?.name).toBe('frontend-pr-review');

    store.setChannelSkill({
      channelId: 'C1',
      skillName: 'frontend-pr-review',
    });
    expect(store.getChannelSkill('C1')).toBe('frontend-pr-review');

    store.setOpsFeedSubscription({
      channelId: 'C1',
      enabled: true,
      updatedBy: 'U1',
    });
    expect(store.isOpsFeedEnabled('C1')).toBe(true);
    expect(store.listOpsFeedChannels()).toContain('C1');

    store.close();
  });
});

describe('activeJobForThread', () => {
  it('returns undefined when no jobs exist', () => {
    const store = new JobStore(tempDbPath());
    expect(store.activeJobForThread('C1', 'T1')).toBeUndefined();
    store.close();
  });

  it('returns the active job when status is RUNNING', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-run',
      eventId: 'e1',
      dedupeKey: 'C1:T1:e1:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: 'T1',
      payload: {},
    });
    const active = store.activeJobForThread('C1', 'T1');
    expect(active).toBeDefined();
    expect(active?.id).toBe('job-run');
    expect(active?.status).toBe('RUNNING');
    expect(active?.workflow).toBe('IMPLEMENTATION');
    store.close();
  });

  it('does NOT return PAUSED jobs from activeJobForThread (slot is freed); pausedJobForThread returns it instead', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-pause',
      eventId: 'e2',
      dedupeKey: 'C1:T2:e2:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: 'T2',
      payload: {},
    });
    store.markJob('job-pause', 'PAUSED');
    expect(store.activeJobForThread('C1', 'T2')).toBeUndefined();
    const paused = store.pausedJobForThread('C1', 'T2');
    expect(paused).toBeDefined();
    expect(paused?.id).toBe('job-pause');
    expect(paused?.workflow).toBe('IMPLEMENTATION');
    store.close();
  });

  it('returns undefined for terminal statuses', () => {
    const store = new JobStore(tempDbPath());
    const statuses = ['SUCCESS', 'FAILED', 'CANCELLED', 'SKIPPED'] as const;
    for (const [i, status] of statuses.entries()) {
      const jobId = `job-term-${i}`;
      const threadTs = `T-${i}`;
      store.createJob({
        id: jobId,
        eventId: `e-${i}`,
        dedupeKey: `C1:${threadTs}:e-${i}:IMPLEMENTATION`,
        workflow: 'IMPLEMENTATION',
        channelId: 'C1',
        threadTs,
        payload: {},
      });
      store.markJob(jobId, status);
      expect(store.activeJobForThread('C1', threadTs)).toBeUndefined();
    }
    store.close();
  });

  it('returns undefined when job is stale beyond threshold', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-stale',
      eventId: 'e-stale',
      dedupeKey: 'C1:T-stale:e-stale:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: 'T-stale',
      payload: {},
    });
    // Manually backdate updated_at to 60 minutes ago
    store['db'].prepare("UPDATE jobs SET updated_at = datetime('now', '-60 minutes') WHERE id = ?").run('job-stale');
    expect(store.activeJobForThread('C1', 'T-stale')).toBeUndefined();
    // With a larger threshold it should still be found
    expect(store.activeJobForThread('C1', 'T-stale', 120)).toBeDefined();
    store.close();
  });

  it('returns the most recently updated job when multiple active jobs exist', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-old',
      eventId: 'e-old',
      dedupeKey: 'C1:T-multi:e-old:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: 'T-multi',
      payload: {},
    });
    store['db'].prepare("UPDATE jobs SET updated_at = datetime('now', '-10 minutes') WHERE id = ?").run('job-old');
    store.createJob({
      id: 'job-new',
      eventId: 'e-new',
      dedupeKey: 'C1:T-multi:e-new:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: 'T-multi',
      payload: {},
    });
    const active = store.activeJobForThread('C1', 'T-multi');
    expect(active?.id).toBe('job-new');
    store.close();
  });
});

describe('pause / resume lifecycle', () => {
  function makePausedJob(store: JobStore, id: string, threadTs: string): void {
    store.createJob({
      id,
      eventId: `e-${id}`,
      dedupeKey: `C1:${threadTs}:e-${id}:IMPLEMENTATION`,
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs,
      payload: {},
    });
  }

  it('persists a resumeContext into result_json on PAUSED transition and reads it back via loadResumeContext', () => {
    const store = new JobStore(tempDbPath());
    makePausedJob(store, 'job-resume-1', 'T-r1');
    const ctx = {
      workflow: 'OWNER_AUTOPILOT' as const,
      stage: 'awaiting_approval' as const,
      iteration: 2,
      feedbackRounds: 1,
      planSteps: ['step a', 'step b'],
      planAffectedFiles: ['src/foo.ts'],
      planScope: 'medium',
      plannerSessionId: 'sess-abc',
      plannerOutput: { plan: ['step a', 'step b'] },
      planMessageTs: '1700000000.000001',
      approvalPromptTs: '1700000010.000002',
      pipelineCwd: '/tmp/wt-workspace',
      pauseCount: 1,
    };
    store.markJob('job-resume-1', 'PAUSED', { result: ctx });
    const loaded = store.loadResumeContext('job-resume-1');
    expect(loaded).toBeDefined();
    if (loaded?.stage === 'awaiting_approval') {
      expect(loaded.iteration).toBe(2);
      expect(loaded.planSteps).toEqual(['step a', 'step b']);
      expect(loaded.plannerSessionId).toBe('sess-abc');
      expect(loaded.pauseCount).toBe(1);
    } else {
      throw new Error('expected awaiting_approval stage');
    }
    store.close();
  });

  it('returns undefined for loadResumeContext when result_json is malformed', () => {
    const store = new JobStore(tempDbPath());
    makePausedJob(store, 'job-resume-bad', 'T-bad');
    // Persist a non-resume payload (e.g. an old-style result without the discriminated stage)
    store.markJob('job-resume-bad', 'SUCCESS', { result: { prUrl: 'https://example.com/pr/1' } });
    expect(store.loadResumeContext('job-resume-bad')).toBeUndefined();
    store.close();
  });

  it('markJobRunning flips PAUSED -> RUNNING and clears result_json', () => {
    const store = new JobStore(tempDbPath());
    makePausedJob(store, 'job-flip', 'T-flip');
    store.markJob('job-flip', 'PAUSED', { result: { stage: 'awaiting_approval', dummy: true } });
    store.markJobRunning('job-flip');
    // After the flip the row should be RUNNING again, and resume context should be cleared.
    expect(store.activeJobForThread('C1', 'T-flip')?.id).toBe('job-flip');
    expect(store.loadResumeContext('job-flip')).toBeUndefined();
    store.close();
  });

  it('stalePausedJobs only returns paused rows older than the threshold', () => {
    const store = new JobStore(tempDbPath());
    makePausedJob(store, 'job-young', 'T-young');
    makePausedJob(store, 'job-old', 'T-old');
    store.markJob('job-young', 'PAUSED');
    store.markJob('job-old', 'PAUSED');
    // Backdate one of them well past the threshold.
    store['db'].prepare("UPDATE jobs SET updated_at = datetime('now', '-30 hours') WHERE id = ?").run('job-old');
    const stale = store.stalePausedJobs(24 * 60);
    const ids = stale.map(j => j.id);
    expect(ids).toContain('job-old');
    expect(ids).not.toContain('job-young');
    store.close();
  });
});

describe('isPausedAwaitingPrUrl', () => {
  function jobWith(store: JobStore, id: string, workflow: 'PR_REVIEW' | 'OWNER_AUTOPILOT' | 'IMPLEMENTATION'): void {
    store.createJob({
      id,
      eventId: `event-${id}`,
      dedupeKey: `dk-${id}`,
      workflow,
      channelId: 'C1',
      threadTs: 'T1',
      payload: {},
    });
  }

  it('returns false for a job that has no logs at all', () => {
    const store = new JobStore(tempDbPath());
    jobWith(store, 'job-empty', 'PR_REVIEW');
    expect(store.isPausedAwaitingPrUrl('job-empty')).toBe(false);
    store.close();
  });

  it('returns true for a PR_REVIEW job that logged pr_review.context.missing', () => {
    const store = new JobStore(tempDbPath());
    jobWith(store, 'job-prr', 'PR_REVIEW');
    store.appendJobLog({
      jobId: 'job-prr',
      stage: 'pr_review.context.missing',
      message: 'PR context missing; asking for URL in thread and pausing.',
      level: 'WARN',
    });
    expect(store.isPausedAwaitingPrUrl('job-prr')).toBe(true);
    store.close();
  });

  it('returns true for an OWNER_AUTOPILOT-recorded job that paused as PR_REVIEW (the regression case from #207 follow-up)', () => {
    // Owner mentions land in jobs.workflow=OWNER_AUTOPILOT even when the
    // classifier later routed them to PR_REVIEW; pr_review.context.missing
    // still gets logged on the same job_id, so the helper must match on
    // the log entry rather than the workflow column.
    const store = new JobStore(tempDbPath());
    jobWith(store, 'job-owner', 'OWNER_AUTOPILOT');
    store.appendJobLog({
      jobId: 'job-owner',
      stage: 'router.classify.override',
      message: 'AI classifier resolved intent: OWNER_AUTOPILOT → PR_REVIEW.',
    });
    store.appendJobLog({
      jobId: 'job-owner',
      stage: 'pr_review.context.missing',
      message: 'PR context missing; asking for URL in thread and pausing.',
      level: 'WARN',
    });
    store.appendJobLog({
      jobId: 'job-owner',
      stage: 'job.attempt.result',
      message: 'Workflow attempt returned a result.',
    });
    expect(store.isPausedAwaitingPrUrl('job-owner')).toBe(true);
    store.close();
  });

  it('returns false for a job that paused for a different reason (e.g. implementation approval)', () => {
    const store = new JobStore(tempDbPath());
    jobWith(store, 'job-impl', 'IMPLEMENTATION');
    store.appendJobLog({
      jobId: 'job-impl',
      stage: 'implementation.approval.waiting',
      message: 'Awaiting plan approval.',
    });
    expect(store.isPausedAwaitingPrUrl('job-impl')).toBe(false);
    store.close();
  });

  it('does not leak state across jobs (per-job isolation)', () => {
    const store = new JobStore(tempDbPath());
    jobWith(store, 'job-a', 'PR_REVIEW');
    jobWith(store, 'job-b', 'PR_REVIEW');
    store.appendJobLog({
      jobId: 'job-a',
      stage: 'pr_review.context.missing',
      message: 'paused',
      level: 'WARN',
    });
    expect(store.isPausedAwaitingPrUrl('job-a')).toBe(true);
    expect(store.isPausedAwaitingPrUrl('job-b')).toBe(false);
    store.close();
  });
});
