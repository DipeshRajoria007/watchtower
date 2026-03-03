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

    store.close();
  });
});
