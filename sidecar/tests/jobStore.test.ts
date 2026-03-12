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
      })
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
      })
    ).toBe('normal');
    expect(
      store.getPersonalityProfile({
        scope: 'user',
        scopeId: 'U1',
      })
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
