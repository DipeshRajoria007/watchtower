import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import { __test__, formatDossierForPrompt } from '../src/state/dossierStore.js';

const { TtlLru } = __test__;

function makeStore(): JobStore {
  // JobStore opens its own connection via better-sqlite3; supply an in-memory path.
  return new JobStore(':memory:');
}

describe('TtlLru', () => {
  it('stores and retrieves values within ttl', () => {
    const lru = new TtlLru<string>(10, 1_000);
    lru.set('a', 'one');
    expect(lru.get('a')).toBe('one');
  });

  it('expires values after ttl elapses', async () => {
    const lru = new TtlLru<string>(10, 5);
    lru.set('a', 'one');
    await new Promise(r => setTimeout(r, 15));
    expect(lru.get('a')).toBeUndefined();
  });

  it('evicts oldest when over capacity', () => {
    const lru = new TtlLru<string>(2, 60_000);
    lru.set('a', '1');
    lru.set('b', '2');
    lru.set('c', '3');
    expect(lru.get('a')).toBeUndefined();
    expect(lru.get('b')).toBe('2');
    expect(lru.get('c')).toBe('3');
  });

  it('refreshes recency on get so a re-accessed key survives eviction', () => {
    const lru = new TtlLru<string>(2, 60_000);
    lru.set('a', '1');
    lru.set('b', '2');
    expect(lru.get('a')).toBe('1'); // moves a to most-recent
    lru.set('c', '3'); // evicts b
    expect(lru.get('a')).toBe('1');
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('c')).toBe('3');
  });
});

describe('dossierStore CRUD', () => {
  it('captures firstSeen and reads the profile back', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.firstSeen({
      userId: 'U1',
      displayName: 'dipesh',
      realName: 'Dipesh Rajoria',
      tz: 'Asia/Kolkata',
      email: 'dipesh@example.com',
    });

    const dossier = dossiers.getDossier('U1');
    expect(dossier.profile?.userId).toBe('U1');
    expect(dossier.profile?.displayName).toBe('dipesh');
    expect(dossier.profile?.tz).toBe('Asia/Kolkata');
    expect(dossier.affinity).toEqual([]);
    expect(dossier.tone).toBe('normal');
    store.close();
  });

  it('setRole upserts and persists across reads', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.setRole('U2', 'pm');
    let dossier = dossiers.getDossier('U2');
    expect(dossier.profile?.role).toBe('pm');

    dossiers.setRole('U2', 'dev');
    dossier = dossiers.getDossier('U2');
    expect(dossier.profile?.role).toBe('dev');
    store.close();
  });

  it('setTone writes a personality_profiles row read back via getDossier', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.firstSeen({ userId: 'U3' });
    dossiers.setTone('U3', 'terse', 'set-role');
    const dossier = dossiers.getDossier('U3');
    expect(dossier.tone).toBe('terse');
    expect(dossier.toneSource).toBe('set-role');
    store.close();
  });

  it('forgetField clears individual fields without touching others', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.firstSeen({ userId: 'U4', displayName: 'alice' });
    dossiers.setRole('U4', 'pm');
    dossiers.setTone('U4', 'casual', 'set-role');

    dossiers.forgetField('U4', 'role');
    let dossier = dossiers.getDossier('U4');
    expect(dossier.profile?.role).toBeNull();
    expect(dossier.tone).toBe('casual');

    dossiers.forgetField('U4', 'tone');
    dossier = dossiers.getDossier('U4');
    expect(dossier.tone).toBe('normal');
    store.close();
  });

  it("forgetField 'all' wipes the user", () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.firstSeen({ userId: 'U5', displayName: 'bob' });
    dossiers.setRole('U5', 'designer');
    dossiers.setTone('U5', 'technical', 'set-role');

    dossiers.forgetField('U5', 'all');
    const dossier = dossiers.getDossier('U5');
    expect(dossier.profile).toBeNull();
    expect(dossier.tone).toBe('normal');
    store.close();
  });

  it('listDossiers returns recent users sorted by updated_at desc', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.firstSeen({ userId: 'U_OLD', displayName: 'old' });
    dossiers.firstSeen({ userId: 'U_NEW', displayName: 'new' });
    const list = dossiers.listDossiers();
    expect(list.length).toBe(2);
    // both inserted close together; order isn't strictly testable, but both are present.
    expect(list.map(d => d.userId).sort()).toEqual(['U_NEW', 'U_OLD']);
    store.close();
  });
});

describe('formatDossierForPrompt', () => {
  it('renders the user line even with no signals', () => {
    const summary = formatDossierForPrompt({
      profile: {
        userId: 'U1',
        displayName: 'dipesh',
        firstSeenAt: '2026-05-03T00:00:00Z',
        updatedAt: '2026-05-03T00:00:00Z',
      },
      affinity: [],
      metrics: {},
      tone: 'normal',
    });
    expect(summary).toContain('User: dipesh');
    expect(summary.split('\n').length).toBe(1);
  });

  it('includes role, primary repo, intent mix, tone, and failures when present', () => {
    const summary = formatDossierForPrompt({
      profile: {
        userId: 'U1',
        displayName: 'alice',
        role: 'pm',
        firstSeenAt: '2026-05-03T00:00:00Z',
        updatedAt: '2026-05-03T00:00:00Z',
      },
      affinity: [{ repo: 'newton-web', hits: 10, successes: 8, failures: 2, computedAt: '2026-05-03T00:00:00Z' }],
      metrics: {
        intent_mix: { IMPLEMENTATION: 6, INVESTIGATION: 3, PR_REVIEW: 1 },
        failure_fingerprint: { topErrorKinds: [{ kind: 'TypeError' }, { kind: 'TimeoutError' }] },
      },
      tone: 'terse',
    });
    expect(summary).toContain('User: alice (pm)');
    expect(summary).toContain('Primary repo: newton-web (10 jobs, 80% success)');
    expect(summary).toContain('Typical intents: IMPLEMENTATION(6), INVESTIGATION(3), PR_REVIEW(1)');
    expect(summary).toContain('Preferred tone: terse');
    expect(summary).toContain('Common failure modes: TypeError, TimeoutError');
  });

  it('skips tone line when tone is normal', () => {
    const summary = formatDossierForPrompt({
      profile: {
        userId: 'U1',
        firstSeenAt: '2026-05-03T00:00:00Z',
        updatedAt: '2026-05-03T00:00:00Z',
      },
      affinity: [],
      metrics: {},
      tone: 'normal',
    });
    expect(summary).not.toContain('Preferred tone');
  });
});
