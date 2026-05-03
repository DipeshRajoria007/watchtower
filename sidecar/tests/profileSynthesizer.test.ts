import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import {
  MIN_MEMORIES_FOR_SYNTHESIS,
  readInferredProfile,
  synthesizeUserProfile,
} from '../src/learning/profileSynthesizer.js';

function seedMemories(store: JobStore, userId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    store.dossierStore().recordMemory({
      userId,
      jobId: `j-${i}`,
      workflow: 'IMPLEMENTATION',
      status: 'SUCCESS',
      repo: 'newton-web',
      summary: `Did thing ${i}`,
    });
  }
}

describe('synthesizeUserProfile — guardrails', () => {
  it('skips when there are fewer than the minimum memories', async () => {
    const store = new JobStore(':memory:');
    seedMemories(store, 'U1', MIN_MEMORIES_FOR_SYNTHESIS - 1);
    const out = await synthesizeUserProfile({ userId: 'U1', store });
    expect(out).toEqual({ ok: false, reason: 'too-few-memories' });
    expect(readInferredProfile({ store, userId: 'U1' })).toBeNull();
    store.close();
  });

  it('returns no-user-id when userId is empty', async () => {
    const store = new JobStore(':memory:');
    const out = await synthesizeUserProfile({ userId: '', store });
    expect(out).toEqual({ ok: false, reason: 'no-user-id' });
    store.close();
  });

  it('skips when last synthesis was within the recency window', async () => {
    const store = new JobStore(':memory:');
    seedMemories(store, 'U1', MIN_MEMORIES_FOR_SYNTHESIS);

    // Pre-seed an existing inferred_profile blob via direct SQL.
    const generatedAt = new Date().toISOString();
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db
      .prepare(
        `INSERT INTO user_metrics(user_id, metric_key, metric_value, computed_at)
         VALUES(?, 'inferred_profile', ?, ?)`,
      )
      .run('U1', JSON.stringify({ text: 'cached prose', samplesCovered: 5, generatedAt }), generatedAt);
    // Bust the LRU so the next read picks up the row.
    store.dossierStore().invalidate('U1');

    const out = await synthesizeUserProfile({ userId: 'U1', store, now: new Date() });
    expect(out).toEqual({ ok: false, reason: 'too-recent' });
    store.close();
  });

  // Note: we don't have unit tests for the recency-guard-release path or
  // the force=true path because exercising them requires actually invoking
  // runCodex, which spawns a child process and is too slow + environment-
  // dependent for unit testing. Those paths are covered by the live Slack
  // smoke check after deploy (see Phase C verification in the plan).
});

describe('readInferredProfile', () => {
  it('returns null when no row exists', () => {
    const store = new JobStore(':memory:');
    expect(readInferredProfile({ store, userId: 'GHOST' })).toBeNull();
    store.close();
  });

  it('reads back a previously-written blob', () => {
    const store = new JobStore(':memory:');
    const generatedAt = '2026-05-04T00:00:00.000Z';
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db
      .prepare(
        `INSERT INTO user_metrics(user_id, metric_key, metric_value, computed_at)
         VALUES(?, 'inferred_profile', ?, ?)`,
      )
      .run('U1', JSON.stringify({ text: 'theOG works on newton-web.', samplesCovered: 12, generatedAt }), generatedAt);
    store.dossierStore().invalidate('U1');
    const out = readInferredProfile({ store, userId: 'U1' });
    expect(out).toEqual({ text: 'theOG works on newton-web.', samplesCovered: 12, generatedAt });
    store.close();
  });

  it('returns null for malformed blobs', () => {
    const store = new JobStore(':memory:');
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db
      .prepare(
        `INSERT INTO user_metrics(user_id, metric_key, metric_value, computed_at)
         VALUES(?, 'inferred_profile', ?, ?)`,
      )
      .run('U1', 'not-json', '2026-05-04T00:00:00Z');
    store.dossierStore().invalidate('U1');
    expect(readInferredProfile({ store, userId: 'U1' })).toBeNull();
    store.close();
  });
});
