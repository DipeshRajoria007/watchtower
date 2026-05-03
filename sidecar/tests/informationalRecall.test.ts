import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import { assembleRecall } from '../src/codex/recallAssembler.js';

/**
 * End-to-end test of the assembleRecall path that the new INFORMATIONAL,
 * INVESTIGATION, and PR_REVIEW wirings will hit. We assert that:
 *  - A user with pinned facts AND a dossier produces a non-empty recall block.
 *  - The block contains the pinned-facts header AND the user's text.
 *  - Token estimates respect the workflow budget.
 */
describe('assembleRecall in non-implementation workflows', () => {
  function seedStore(userId: string): JobStore {
    const store = new JobStore(':memory:');
    store.dossierStore().firstSeen({ userId, displayName: 'Tester' });
    store.dossierStore().addPinnedFact({
      userId,
      text: 'prefer terse PR review summaries',
      source: 'slack-remember',
    });
    store.dossierStore().addPinnedFact({
      userId,
      text: 'dashboard rewrite started 2026-04-15',
      source: 'slack-remember',
    });
    // A handful of memories so dossier rollup writes affinity rows.
    for (let i = 0; i < 3; i++) {
      store.dossierStore().recordMemory({
        userId,
        jobId: `j-${i}`,
        workflow: 'IMPLEMENTATION',
        status: 'SUCCESS',
        repo: 'newton-web',
        summary: `Did thing ${i}`,
      });
    }
    return store;
  }

  it('emits pinned facts in the recall block for INFORMATIONAL', async () => {
    const store = seedStore('U1');
    const recall = await assembleRecall({ userId: 'U1', workflow: 'INFORMATIONAL', store });
    expect(recall.promptBlock).toContain('Things to remember (the user told me):');
    expect(recall.promptBlock).toContain('- prefer terse PR review summaries');
    expect(recall.promptBlock).toContain('- dashboard rewrite started 2026-04-15');
    expect(recall.sources).toContain('pinned');
    store.close();
  });

  it('emits pinned facts in the recall block for INVESTIGATION', async () => {
    const store = seedStore('U2');
    const recall = await assembleRecall({ userId: 'U2', workflow: 'INVESTIGATION', store });
    expect(recall.promptBlock).toContain('Things to remember (the user told me):');
    expect(recall.promptBlock).toContain('- prefer terse PR review summaries');
    store.close();
  });

  it('emits pinned facts in the recall block for PR_REVIEW even with the tightest budget', async () => {
    const store = seedStore('U3');
    const recall = await assembleRecall({ userId: 'U3', workflow: 'PR_REVIEW', store });
    // PR_REVIEW budget is 800 — pinned facts should always survive.
    expect(recall.promptBlock).toContain('Things to remember (the user told me):');
    expect(recall.promptBlock).toContain('- prefer terse PR review summaries');
    expect(recall.estimatedTokens).toBeLessThanOrEqual(800);
    store.close();
  });

  it('returns an empty block for unknown users (no churn, no wasted tokens)', async () => {
    const store = new JobStore(':memory:');
    const recall = await assembleRecall({ userId: 'U_GHOST', workflow: 'INFORMATIONAL', store });
    expect(recall.promptBlock).toBe('');
    expect(recall.sources).toEqual([]);
    store.close();
  });

  it('respects the per-workflow token budget cap', async () => {
    const store = seedStore('U4');
    const informational = await assembleRecall({ userId: 'U4', workflow: 'INFORMATIONAL', store });
    const investigation = await assembleRecall({ userId: 'U4', workflow: 'INVESTIGATION', store });
    const prReview = await assembleRecall({ userId: 'U4', workflow: 'PR_REVIEW', store });
    expect(informational.estimatedTokens).toBeLessThanOrEqual(1000);
    expect(investigation.estimatedTokens).toBeLessThanOrEqual(1200);
    expect(prReview.estimatedTokens).toBeLessThanOrEqual(800);
    store.close();
  });
});
