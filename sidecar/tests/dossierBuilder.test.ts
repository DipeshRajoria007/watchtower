import { describe, expect, it } from 'vitest';
import {
  computeActiveHours,
  computeFailureFingerprint,
  computeIntentMix,
  computeProjectAffinity,
  computeResponseStyle,
  rollupWindowStart,
  type LearningSignalRow,
} from '../src/state/dossierBuilder.js';

const NOW = new Date('2026-05-03T12:00:00Z');

function row(partial: Partial<LearningSignalRow>): LearningSignalRow {
  return {
    userId: 'U1',
    status: 'SUCCESS',
    correctionApplied: 0,
    createdAt: NOW.toISOString(),
    ...partial,
  };
}

describe('rollupWindowStart', () => {
  it('returns 30 days before the supplied now', () => {
    const start = rollupWindowStart(NOW);
    expect(NOW.getTime() - start.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('computeProjectAffinity', () => {
  it('groups hits/successes/failures by repo', () => {
    const result = computeProjectAffinity([
      row({ repo: 'newton-web', status: 'SUCCESS' }),
      row({ repo: 'newton-web', status: 'SUCCESS' }),
      row({ repo: 'newton-web', status: 'FAILED' }),
      row({ repo: 'newton-api', status: 'SUCCESS' }),
    ]);
    expect(result).toEqual([
      expect.objectContaining({ repo: 'newton-web', hits: 3, successes: 2, failures: 1 }),
      expect.objectContaining({ repo: 'newton-api', hits: 1, successes: 1, failures: 0 }),
    ]);
  });

  it('skips rows with no repo', () => {
    const result = computeProjectAffinity([row({ repo: null }), row({ repo: '' }), row({ repo: 'newton-web' })]);
    expect(result).toEqual([expect.objectContaining({ repo: 'newton-web', hits: 1 })]);
  });

  it('records most recent lastUsedAt per repo', () => {
    const result = computeProjectAffinity([
      row({ repo: 'newton-web', createdAt: '2026-04-15T00:00:00Z' }),
      row({ repo: 'newton-web', createdAt: '2026-05-01T00:00:00Z' }),
    ]);
    expect(result[0].lastUsedAt).toBe('2026-05-01T00:00:00Z');
  });
});

describe('computeFailureFingerprint', () => {
  it('counts top error kinds across the full window', () => {
    const result = computeFailureFingerprint(
      [
        row({ status: 'FAILED', errorKind: 'TypeError' }),
        row({ status: 'FAILED', errorKind: 'TypeError' }),
        row({ status: 'FAILED', errorKind: 'Timeout' }),
        row({ status: 'SUCCESS', errorKind: null }),
      ],
      NOW,
    );
    expect(result.topErrorKinds[0]).toEqual({ kind: 'TypeError', count: 2 });
    expect(result.topErrorKinds[1]).toEqual({ kind: 'Timeout', count: 1 });
  });

  it('computes failureRate7d only over rows in the last 7 days', () => {
    const sevenDaysAgo = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const elevenDaysAgo = new Date(NOW.getTime() - 11 * 24 * 60 * 60 * 1000);
    const result = computeFailureFingerprint(
      [
        row({ status: 'FAILED', errorKind: 'X', createdAt: sevenDaysAgo.toISOString() }),
        row({ status: 'SUCCESS', createdAt: sevenDaysAgo.toISOString() }),
        row({ status: 'FAILED', errorKind: 'Y', createdAt: elevenDaysAgo.toISOString() }),
        row({ status: 'FAILED', errorKind: 'Y', createdAt: elevenDaysAgo.toISOString() }),
      ],
      NOW,
    );
    expect(result.samples).toBe(2);
    expect(result.failureRate7d).toBeCloseTo(0.5);
    expect(result.topErrorKinds.map(t => t.kind).sort()).toEqual(['X', 'Y']);
  });

  it('returns 0 failure rate when there are no recent samples', () => {
    expect(computeFailureFingerprint([], NOW)).toEqual({
      topErrorKinds: [],
      failureRate7d: 0,
      samples: 0,
    });
  });
});

describe('computeIntentMix', () => {
  it('counts each intent', () => {
    const result = computeIntentMix([
      row({ intent: 'IMPLEMENTATION' }),
      row({ intent: 'IMPLEMENTATION' }),
      row({ intent: 'INVESTIGATION' }),
      row({ intent: null, workflow: 'PR_REVIEW' }),
    ]);
    expect(result).toEqual({ IMPLEMENTATION: 2, INVESTIGATION: 1, PR_REVIEW: 1 });
  });
});

describe('computeResponseStyle', () => {
  it('returns normal when there are too few samples', () => {
    const result = computeResponseStyle(Array.from({ length: 5 }, () => row({ personalityMode: 'terse' })));
    expect(result.suggestedMode).toBe('normal');
    expect(result.samples).toBe(5);
  });

  it('returns dominant mode when ≥20 samples and ≥70% confidence', () => {
    const signals: LearningSignalRow[] = [];
    for (let i = 0; i < 16; i++) signals.push(row({ personalityMode: 'terse' }));
    for (let i = 0; i < 4; i++) signals.push(row({ personalityMode: 'normal' }));
    const result = computeResponseStyle(signals);
    expect(result.suggestedMode).toBe('terse');
    expect(result.confidence).toBeCloseTo(16 / 20);
  });

  it('returns normal when no mode dominates above 70%', () => {
    const signals: LearningSignalRow[] = [];
    for (let i = 0; i < 12; i++) signals.push(row({ personalityMode: 'terse' }));
    for (let i = 0; i < 12; i++) signals.push(row({ personalityMode: 'casual' }));
    const result = computeResponseStyle(signals);
    expect(result.suggestedMode).toBe('normal');
  });
});

describe('computeActiveHours', () => {
  it('returns the busiest UTC hour', () => {
    const signals: LearningSignalRow[] = [];
    for (let i = 0; i < 5; i++) signals.push(row({ createdAt: '2026-05-03T14:23:00Z' }));
    for (let i = 0; i < 2; i++) signals.push(row({ createdAt: '2026-05-03T03:10:00Z' }));
    const result = computeActiveHours(signals);
    expect(result.busiestHourUtc).toBe(14);
    expect(result.samples).toBe(7);
  });

  it('returns null hour when no rows', () => {
    expect(computeActiveHours([])).toEqual({ busiestHourUtc: null, samples: 0 });
  });
});
