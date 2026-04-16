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

  it('returns the active job when status is PAUSED', () => {
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
    const active = store.activeJobForThread('C1', 'T2');
    expect(active).toBeDefined();
    expect(active?.id).toBe('job-pause');
    expect(active?.status).toBe('PAUSED');
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
