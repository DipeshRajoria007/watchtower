import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-store-aje-')), 'watchtower.db');
}

describe('jobStore.activeJobForEventTs', () => {
  it('returns RUNNING job whose payload.eventTs matches', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-running',
      eventId: 'Ev0RUN',
      dedupeKey: 'C1:111:111:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: '111',
      payload: { eventTs: '111' },
    });

    const active = store.activeJobForEventTs('C1', '111');
    expect(active).toBeDefined();
    expect(active?.id).toBe('job-running');
    expect(active?.workflow).toBe('IMPLEMENTATION');
    expect(active?.status).toBe('RUNNING');
    expect(active?.threadTs).toBe('111');
  });

  it('returns PAUSED jobs (a deletion should cancel them too)', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-paused',
      eventId: 'Ev0PAUSE',
      dedupeKey: 'C1:222:222:PR_REVIEW',
      workflow: 'PR_REVIEW',
      channelId: 'C1',
      threadTs: '222',
      payload: { eventTs: '222' },
    });
    store.markJob('job-paused', 'PAUSED');

    const active = store.activeJobForEventTs('C1', '222');
    expect(active?.id).toBe('job-paused');
    expect(active?.status).toBe('PAUSED');
  });

  it('ignores terminal-status jobs (SUCCESS / FAILED / CANCELLED / SKIPPED)', () => {
    const store = new JobStore(tempDbPath());
    for (const [id, status] of [
      ['job-success', 'SUCCESS'],
      ['job-failed', 'FAILED'],
      ['job-cancelled', 'CANCELLED'],
      ['job-skipped', 'SKIPPED'],
    ] as const) {
      store.createJob({
        id,
        eventId: `Ev_${id}`,
        dedupeKey: `C1:${id}:${id}:IMPLEMENTATION`,
        workflow: 'IMPLEMENTATION',
        channelId: 'C1',
        threadTs: id,
        payload: { eventTs: id },
      });
      store.markJob(id, status);
    }

    for (const id of ['job-success', 'job-failed', 'job-cancelled', 'job-skipped']) {
      const active = store.activeJobForEventTs('C1', id);
      expect(active, `${id} should be terminal and not returned`).toBeUndefined();
    }
  });

  it('returns undefined when no job exists for that ts', () => {
    const store = new JobStore(tempDbPath());
    expect(store.activeJobForEventTs('C1', 'nope')).toBeUndefined();
  });

  it('scopes by channelId — same eventTs in a different channel does not match', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-other-channel',
      eventId: 'Ev0OTHER',
      dedupeKey: 'C2:333:333:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C2',
      threadTs: '333',
      payload: { eventTs: '333' },
    });

    expect(store.activeJobForEventTs('C1', '333')).toBeUndefined();
    expect(store.activeJobForEventTs('C2', '333')?.id).toBe('job-other-channel');
  });
});
