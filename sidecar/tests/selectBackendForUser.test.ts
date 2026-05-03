import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import { selectBackendForUser, setActiveBackend } from '../src/codex/runCodex.js';

describe('selectBackendForUser', () => {
  it('falls back to active backend when the user has no dossier', () => {
    setActiveBackend('codex');
    const store = new JobStore(':memory:');
    const result = selectBackendForUser({
      userId: 'U_GHOST',
      workflow: 'IMPLEMENTATION',
      dossierStore: store.dossierStore(),
    });
    expect(result).toBe('codex');
    store.close();
  });

  it('routes to claude-code when 7-day failure rate exceeds 40% on IMPLEMENTATION', () => {
    setActiveBackend('codex');
    const store = new JobStore(':memory:');
    const dossiers = store.dossierStore();
    // 6 failures, 4 successes — 60% failure rate, well above 40%.
    for (let i = 0; i < 6; i++) {
      store.recordLearningSignal({
        jobId: `f-${i}`,
        eventId: `ev-f-${i}`,
        channelId: 'C1',
        userId: 'U1',
        workflow: 'IMPLEMENTATION',
        intent: 'IMPLEMENTATION',
        status: 'FAILED',
        correctionApplied: false,
        errorKind: 'TypeError',
        repo: 'newton-web',
      });
    }
    for (let i = 0; i < 4; i++) {
      store.recordLearningSignal({
        jobId: `s-${i}`,
        eventId: `ev-s-${i}`,
        channelId: 'C1',
        userId: 'U1',
        workflow: 'IMPLEMENTATION',
        intent: 'IMPLEMENTATION',
        status: 'SUCCESS',
        correctionApplied: false,
        repo: 'newton-web',
      });
    }
    // Trigger lazy rollup so failure_fingerprint is populated.
    dossiers.getDossier('U1');
    dossiers.invalidate('U1');

    let chosenReason: string | undefined;
    const result = selectBackendForUser({
      userId: 'U1',
      workflow: 'IMPLEMENTATION',
      dossierStore: dossiers,
      onSelect: info => {
        chosenReason = info.reason;
      },
    });
    expect(result).toBe('claude-code');
    expect(chosenReason).toBe('high-failure-rate-implementation');
    store.close();
  });

  it('does not route to claude-code on non-IMPLEMENTATION workflows', () => {
    setActiveBackend('codex');
    const store = new JobStore(':memory:');
    const dossiers = store.dossierStore();
    for (let i = 0; i < 5; i++) {
      store.recordLearningSignal({
        jobId: `f-${i}`,
        eventId: `ev-f-${i}`,
        channelId: 'C1',
        userId: 'U2',
        workflow: 'IMPLEMENTATION',
        intent: 'IMPLEMENTATION',
        status: 'FAILED',
        correctionApplied: false,
        errorKind: 'TypeError',
        repo: 'newton-web',
      });
    }
    dossiers.getDossier('U2');
    dossiers.invalidate('U2');

    const result = selectBackendForUser({
      userId: 'U2',
      workflow: 'INVESTIGATION',
      dossierStore: dossiers,
    });
    expect(result).toBe('codex');
    store.close();
  });
});
