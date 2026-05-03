import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';

describe('user_memories — recordMemory + recentMemoriesForUser', () => {
  it('appends rows and reads them back newest-first', () => {
    const store = new JobStore(':memory:');
    const dossiers = store.dossierStore();

    dossiers.recordMemory({
      userId: 'U1',
      jobId: 'j-1',
      workflow: 'IMPLEMENTATION',
      status: 'SUCCESS',
      repo: 'newton-web',
      prUrl: 'https://github.com/x/y/pull/3421',
      summary: 'Fixed dashboard hydration error in Header.tsx',
    });
    dossiers.recordMemory({
      userId: 'U1',
      jobId: 'j-2',
      workflow: 'INVESTIGATION',
      status: 'SUCCESS',
      repo: 'newton-api',
      summary: 'Diagnosed /v1/leaderboard timeout (missing index)',
    });

    const rows = dossiers.recentMemoriesForUser('U1', 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      jobId: 'j-2',
      workflow: 'INVESTIGATION',
      summary: 'Diagnosed /v1/leaderboard timeout (missing index)',
    });
    expect(rows[1].prUrl).toBe('https://github.com/x/y/pull/3421');
    store.close();
  });

  it('honors the limit argument', () => {
    const store = new JobStore(':memory:');
    const dossiers = store.dossierStore();
    for (let i = 0; i < 12; i++) {
      dossiers.recordMemory({
        userId: 'U2',
        jobId: `j-${i}`,
        workflow: 'IMPLEMENTATION',
        status: 'SUCCESS',
        summary: `entry ${i}`,
      });
    }
    expect(dossiers.recentMemoriesForUser('U2', 5)).toHaveLength(5);
    store.close();
  });

  it('isolates memories per user', () => {
    const store = new JobStore(':memory:');
    const dossiers = store.dossierStore();
    dossiers.recordMemory({ userId: 'A', summary: 'alpha' });
    dossiers.recordMemory({ userId: 'B', summary: 'bravo' });
    expect(dossiers.recentMemoriesForUser('A').map(r => r.summary)).toEqual(['alpha']);
    expect(dossiers.recentMemoriesForUser('B').map(r => r.summary)).toEqual(['bravo']);
    store.close();
  });
});

describe('user_memories — privacy invariant', () => {
  // The recordMemory input shape has no field for the user's raw event.text.
  // This test asserts the schema has no field that could carry it through.
  it('schema exposes only summary, not raw input', () => {
    const store = new JobStore(':memory:');
    const id = store.dossierStore().recordMemory({
      userId: 'U_PRIV',
      summary: 'workflow output goes here',
    });
    expect(typeof id).toBe('number');
    const rows = store.dossierStore().recentMemoriesForUser('U_PRIV', 1);
    const row = rows[0]!;
    // The row keys are the only data shape persisted; if the DB ever leaks
    // raw input it'd be here.
    expect(Object.keys(row).sort()).toEqual(
      ['createdAt', 'id', 'jobId', 'prUrl', 'repo', 'status', 'summary', 'userId', 'workflow'].sort(),
    );
    store.close();
  });
});
