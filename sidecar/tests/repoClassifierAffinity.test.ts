import { describe, expect, it } from 'vitest';
import { classifyRepo } from '../src/router/repoClassifier.js';

describe('classifyRepo with affinity prior', () => {
  it('breaks ties toward the user’s preferred repo when text scores match', () => {
    const text = 'frontend api page endpoint'; // hits one web rule and one api rule
    const noAffinity = classifyRepo([text], 0.6);
    expect(noAffinity.scoreWeb).toBe(noAffinity.scoreApi);

    const apiBiased = classifyRepo([text], 0.6, { newtonApiHits: 20 });
    expect(apiBiased.selectedRepo).toBe('newton-api');
    expect(apiBiased.signals.some(s => s.startsWith('affinity-prior:'))).toBe(true);
  });

  it('does not flip selection when text signals dominate', () => {
    // newton-web has both keyword (3) and stacktrace (2) signals = 5
    const result = classifyRepo(['React hydration TypeError: Cannot read properties of undefined'], 0.6, {
      newtonApiHits: 20,
    });
    // 5 * 1.0 (web) vs 0 * 1.30 (api) — web still wins.
    expect(result.selectedRepo).toBe('newton-web');
  });

  it('treats undefined or zero affinity as a no-op (no signal noise)', () => {
    const a = classifyRepo(['react component'], 0.5);
    const b = classifyRepo(['react component'], 0.5, {});
    const c = classifyRepo(['react component'], 0.5, { newtonWebHits: 0, newtonApiHits: 0 });
    expect(a.scoreWeb).toBe(b.scoreWeb);
    expect(b.scoreWeb).toBe(c.scoreWeb);
    // No prior signal logged when both sides are 1.0.
    expect(c.signals.some(s => s.startsWith('affinity-prior:'))).toBe(false);
  });
});
