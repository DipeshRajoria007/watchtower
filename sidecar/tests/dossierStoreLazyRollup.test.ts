import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';

function makeStore(): JobStore {
  return new JobStore(':memory:');
}

function emit(
  store: JobStore,
  partial: {
    jobId: string;
    userId: string;
    intent?: string;
    status?: 'SUCCESS' | 'FAILED';
    repo?: string;
    errorKind?: string;
    personalityMode?: 'normal' | 'terse' | 'technical' | 'casual';
  },
): void {
  store.recordLearningSignal({
    jobId: partial.jobId,
    eventId: `ev-${partial.jobId}`,
    channelId: 'C123',
    userId: partial.userId,
    workflow: 'IMPLEMENTATION',
    intent: (partial.intent ?? 'IMPLEMENTATION') as never,
    status: partial.status ?? 'SUCCESS',
    correctionApplied: false,
    errorKind: partial.errorKind,
    repo: partial.repo,
    personalityMode: partial.personalityMode,
  });
}

describe('lazy dossier rollup', () => {
  it('populates affinity and metrics on first getDossier read', () => {
    const store = makeStore();
    emit(store, { jobId: 'j1', userId: 'U1', repo: 'newton-web', status: 'SUCCESS' });
    emit(store, { jobId: 'j2', userId: 'U1', repo: 'newton-web', status: 'SUCCESS' });
    emit(store, { jobId: 'j3', userId: 'U1', repo: 'newton-api', status: 'FAILED', errorKind: 'TypeError' });

    const dossier = store.dossierStore().getDossier('U1');
    expect(dossier.affinity.length).toBe(2);
    const web = dossier.affinity.find(a => a.repo === 'newton-web');
    expect(web).toMatchObject({ hits: 2, successes: 2, failures: 0 });
    expect(dossier.metrics.intent_mix).toEqual({ IMPLEMENTATION: 3 });
    const fp = dossier.metrics.failure_fingerprint as { topErrorKinds: Array<{ kind: string }> };
    expect(fp.topErrorKinds.map(t => t.kind)).toContain('TypeError');
    store.close();
  });

  it('recomputes when a new signal arrives after the last rollup', async () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    emit(store, { jobId: 'j1', userId: 'U2', repo: 'newton-web', status: 'SUCCESS' });

    let dossier = dossiers.getDossier('U2');
    expect(dossier.affinity[0]).toMatchObject({ repo: 'newton-web', hits: 1 });

    // Sleep so the new signal's created_at strictly exceeds the prior rollup's
    // computed_at — production hits this naturally because invalidate + the
    // next dossier read are separated by job-completion latency.
    await new Promise(r => setTimeout(r, 10));

    emit(store, { jobId: 'j2', userId: 'U2', repo: 'newton-web', status: 'FAILED' });
    dossiers.invalidate('U2');

    dossier = dossiers.getDossier('U2');
    expect(dossier.affinity[0]).toMatchObject({ repo: 'newton-web', hits: 2, failures: 1 });
    store.close();
  });

  it('does not write metrics for users with no signals', () => {
    const store = makeStore();
    const dossier = store.dossierStore().getDossier('U_GHOST');
    expect(dossier.profile).toBeNull();
    expect(dossier.affinity).toEqual([]);
    expect(dossier.metrics).toEqual({});
    store.close();
  });

  it('preserves operator-set tone — passive learning never overwrites set-role', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();

    // Operator pinned tone first.
    dossiers.firstSeen({ userId: 'U3' });
    dossiers.setTone('U3', 'casual', 'set-role');

    // Now flood with terse-mode signals (≥20, dominant) — the rollup would
    // suggest 'terse', but the operator's casual tone must survive.
    for (let i = 0; i < 25; i++) {
      emit(store, { jobId: `t-${i}`, userId: 'U3', repo: 'newton-web', personalityMode: 'terse' });
    }
    dossiers.invalidate('U3');

    const dossier = dossiers.getDossier('U3');
    expect(dossier.tone).toBe('casual');
    expect(dossier.toneSource).toBe('set-role');
    store.close();
  });

  it('passive learning does write tone when no operator-set row exists', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    for (let i = 0; i < 25; i++) {
      emit(store, { jobId: `t-${i}`, userId: 'U4', repo: 'newton-web', personalityMode: 'technical' });
    }
    const dossier = dossiers.getDossier('U4');
    expect(dossier.tone).toBe('technical');
    expect(dossier.toneSource).toBe('passive-learn');
    store.close();
  });

  it('drops affinity rows for repos that fall out of the 30-day window', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();

    // Old signal for newton-api (45 days back) — should not appear in affinity.
    const longAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    // Insert directly to bypass createdAt = now; record via raw SQL.
    (store as unknown as { db: import('better-sqlite3').Database }).db
      .prepare(
        `INSERT INTO learning_signals(
           job_id, event_id, channel_id, user_id, workflow, status, intent,
           correction_applied, personality_mode, error_kind, repo, created_at
         ) VALUES('old', 'ev-old', 'C', 'U5', 'IMPLEMENTATION', 'SUCCESS', 'IMPLEMENTATION',
                  0, 'normal', NULL, 'newton-api', ?)`,
      )
      .run(longAgo);

    emit(store, { jobId: 'recent', userId: 'U5', repo: 'newton-web', status: 'SUCCESS' });

    const dossier = dossiers.getDossier('U5');
    expect(dossier.affinity.map(a => a.repo)).toEqual(['newton-web']);
    store.close();
  });
});
