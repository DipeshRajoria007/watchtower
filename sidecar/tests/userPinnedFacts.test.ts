import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import { PINNED_FACT_MAX_CHARS, PINNED_FACT_USER_CAP } from '../src/state/dossierStore.js';
import { parseMiniogSubcommand } from '../src/router/intentParser.js';

describe('parseMiniogSubcommand — Phase B verbs', () => {
  it('parses `remember <text>` and preserves case', () => {
    const result = parseMiniogSubcommand('<@UBOT> remember Dashboard rewrite started 2026-04-15');
    expect(result).toEqual({ kind: 'remember', text: 'Dashboard rewrite started 2026-04-15' });
  });

  it("strips Slack's '*Sent using* <@bot>' attribution from remember text", () => {
    const result = parseMiniogSubcommand(
      '<@UBOT> remember prefer terse PR review summaries\n*Sent using* <@U0ACB8RHKED|Claude>',
    );
    expect(result).toEqual({ kind: 'remember', text: 'prefer terse PR review summaries' });
  });

  it('strips inline *Sent using* on a single line', () => {
    const result = parseMiniogSubcommand('remember dashboard fix *Sent using* <@U0ACB8RHKED|Claude>');
    expect(result).toEqual({ kind: 'remember', text: 'dashboard fix' });
  });

  it('rejects bare `remember` with no text', () => {
    expect(parseMiniogSubcommand('remember')).toBeNull();
    expect(parseMiniogSubcommand('remember   ')).toBeNull();
  });

  it('caps remember text at PINNED_FACT_MAX_CHARS', () => {
    const long = 'x'.repeat(500);
    const result = parseMiniogSubcommand(`remember ${long}`);
    expect(result).toMatchObject({ kind: 'remember' });
    if (result?.kind === 'remember') {
      expect(result.text.length).toBe(PINNED_FACT_MAX_CHARS);
    }
  });

  it('parses `memories`', () => {
    expect(parseMiniogSubcommand('memories')).toEqual({ kind: 'memories' });
    expect(parseMiniogSubcommand('<@UBOT>  memories  ')).toEqual({ kind: 'memories' });
  });

  it('parses `forget memory <id>`', () => {
    expect(parseMiniogSubcommand('forget memory 42')).toEqual({ kind: 'forget-memory', id: 42 });
    expect(parseMiniogSubcommand('<@UBOT> forget memory 1')).toEqual({ kind: 'forget-memory', id: 1 });
  });

  it('rejects malformed `forget memory`', () => {
    expect(parseMiniogSubcommand('forget memory')).toBeNull();
    expect(parseMiniogSubcommand('forget memory abc')).toBeNull();
    expect(parseMiniogSubcommand('forget memory -1')).toBeNull();
  });

  it('still routes `forget role` and `forget all` correctly', () => {
    expect(parseMiniogSubcommand('forget role')).toEqual({ kind: 'forget', field: 'role', confirmed: true });
    expect(parseMiniogSubcommand('forget all confirm')).toEqual({
      kind: 'forget',
      field: 'all',
      confirmed: true,
    });
  });
});

describe('addPinnedFact / listPinnedFacts / removePinnedFact', () => {
  it('round-trips a single fact', () => {
    const store = new JobStore(':memory:');
    const out = store.dossierStore().addPinnedFact({
      userId: 'U1',
      text: 'prefers terse PR review summaries',
      source: 'slack-remember',
    });
    expect(out).not.toBeNull();
    expect(out!.row.text).toBe('prefers terse PR review summaries');
    expect(out!.rotatedOut).toBeNull();

    const list = store.dossierStore().listPinnedFacts('U1');
    expect(list.map(f => f.text)).toEqual(['prefers terse PR review summaries']);
    store.close();
  });

  it('returns null when text is empty', () => {
    const store = new JobStore(':memory:');
    expect(store.dossierStore().addPinnedFact({ userId: 'U1', text: '   ', source: 'slack-remember' })).toBeNull();
    expect(store.dossierStore().addPinnedFact({ userId: 'U1', text: '', source: 'slack-remember' })).toBeNull();
    store.close();
  });

  it('is idempotent for duplicate text', () => {
    const store = new JobStore(':memory:');
    const a = store.dossierStore().addPinnedFact({ userId: 'U1', text: 'foo', source: 'slack-remember' });
    const b = store.dossierStore().addPinnedFact({ userId: 'U1', text: 'foo', source: 'vault-edit' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.row.id).toBe(a!.row.id);
    expect(store.dossierStore().listPinnedFacts('U1')).toHaveLength(1);
    store.close();
  });

  it('rotates out the oldest entry when over the per-user cap', () => {
    const store = new JobStore(':memory:');
    let firstId: number | null = null;
    for (let i = 0; i < PINNED_FACT_USER_CAP + 1; i++) {
      const result = store.dossierStore().addPinnedFact({
        userId: 'U1',
        text: `fact-${i}`,
        source: 'slack-remember',
      });
      expect(result).not.toBeNull();
      if (i === 0) firstId = result!.row.id;
      if (i === PINNED_FACT_USER_CAP) {
        expect(result!.rotatedOut).not.toBeNull();
        expect(result!.rotatedOut!.id).toBe(firstId!);
      }
    }
    expect(store.dossierStore().listPinnedFacts('U1')).toHaveLength(PINNED_FACT_USER_CAP);
    store.close();
  });

  it('isolates pinned facts per user', () => {
    const store = new JobStore(':memory:');
    store.dossierStore().addPinnedFact({ userId: 'A', text: 'alpha', source: 'slack-remember' });
    store.dossierStore().addPinnedFact({ userId: 'B', text: 'bravo', source: 'slack-remember' });
    expect(
      store
        .dossierStore()
        .listPinnedFacts('A')
        .map(f => f.text),
    ).toEqual(['alpha']);
    expect(
      store
        .dossierStore()
        .listPinnedFacts('B')
        .map(f => f.text),
    ).toEqual(['bravo']);
    store.close();
  });

  it('removePinnedFact removes by id and is owner-scoped', () => {
    const store = new JobStore(':memory:');
    const a = store.dossierStore().addPinnedFact({ userId: 'A', text: 'alpha', source: 'slack-remember' });
    expect(store.dossierStore().removePinnedFact('A', a!.row.id)).toBe(true);
    expect(store.dossierStore().listPinnedFacts('A')).toHaveLength(0);

    const b = store.dossierStore().addPinnedFact({ userId: 'B', text: 'bravo', source: 'slack-remember' });
    // Wrong user can't remove.
    expect(store.dossierStore().removePinnedFact('A', b!.row.id)).toBe(false);
    expect(store.dossierStore().listPinnedFacts('B')).toHaveLength(1);
    store.close();
  });

  it('removePinnedFact returns false for unknown id', () => {
    const store = new JobStore(':memory:');
    expect(store.dossierStore().removePinnedFact('U1', 9999)).toBe(false);
    store.close();
  });
});
