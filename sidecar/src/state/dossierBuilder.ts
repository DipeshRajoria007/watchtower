import type { JobRecord, PersonalityMode, WorkflowIntent } from '../types/contracts.js';

/**
 * A single learning_signals row, narrowed to the columns the rollup functions
 * actually need. The rollup is a pure transform — pass rows in, get aggregates
 * out — so the input shape is decoupled from JobStore internals.
 */
export interface LearningSignalRow {
  jobId?: string | null;
  channelId?: string | null;
  userId: string | null;
  workflow?: WorkflowIntent | string | null;
  intent?: WorkflowIntent | string | null;
  status: JobRecord['status'] | null;
  correctionApplied: number | boolean | null;
  personalityMode?: PersonalityMode | string | null;
  errorKind?: string | null;
  repo?: string | null;
  product?: string | null;
  createdAt: string;
}

export interface ProjectAffinity {
  repo: string;
  hits: number;
  successes: number;
  failures: number;
  lastUsedAt?: string;
}

export interface ProductAffinity {
  product: string;
  hits: number;
  successes: number;
  failures: number;
  lastUsedAt?: string;
}

export interface FailureFingerprint {
  topErrorKinds: Array<{ kind: string; count: number }>;
  failureRate7d: number;
  samples: number;
}

export type IntentMix = Record<string, number>;

export interface ResponseStyleSuggestion {
  suggestedMode: PersonalityMode;
  confidence: number;
  samples: number;
}

export interface ActiveHours {
  busiestHourUtc: number | null;
  samples: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const ROLLUP_WINDOW_DAYS = 30;
export const FAILURE_WINDOW_DAYS = 7;

/** Rows older than this (relative to `now`) are excluded from rollups. */
export function rollupWindowStart(now = new Date()): Date {
  return new Date(now.getTime() - ROLLUP_WINDOW_DAYS * MS_PER_DAY);
}

function safeDate(value: string): Date | null {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Per-(user, repo) hits / successes / failures, last 30d.
 * Skips rows with no `repo` (e.g., signals recorded before Phase 1).
 */
export function computeProjectAffinity(signals: LearningSignalRow[]): ProjectAffinity[] {
  const byRepo = new Map<string, ProjectAffinity>();
  for (const sig of signals) {
    const repo = (sig.repo ?? '').trim();
    if (!repo) continue;
    const entry = byRepo.get(repo) ?? { repo, hits: 0, successes: 0, failures: 0 };
    entry.hits += 1;
    if (sig.status === 'SUCCESS') entry.successes += 1;
    else if (sig.status === 'FAILED') entry.failures += 1;
    if (!entry.lastUsedAt || sig.createdAt > entry.lastUsedAt) {
      entry.lastUsedAt = sig.createdAt;
    }
    byRepo.set(repo, entry);
  }
  return [...byRepo.values()].sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    return b.successes - a.successes;
  });
}

/**
 * Per-(user, product) hits / successes / failures, last 30d.
 * Skips rows with no `product` (signals predating the product classifier or
 * jobs that did not match any product rule).
 */
export function computeProductAffinity(signals: LearningSignalRow[]): ProductAffinity[] {
  const byProduct = new Map<string, ProductAffinity>();
  for (const sig of signals) {
    const product = (sig.product ?? '').trim();
    if (!product) continue;
    const entry = byProduct.get(product) ?? { product, hits: 0, successes: 0, failures: 0 };
    entry.hits += 1;
    if (sig.status === 'SUCCESS') entry.successes += 1;
    else if (sig.status === 'FAILED') entry.failures += 1;
    if (!entry.lastUsedAt || sig.createdAt > entry.lastUsedAt) {
      entry.lastUsedAt = sig.createdAt;
    }
    byProduct.set(product, entry);
  }
  return [...byProduct.values()].sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    return b.successes - a.successes;
  });
}

/**
 * Top error kinds and 7-day failure rate. Failure rate is computed over rows
 * within the last 7 days only — older rows count toward `topErrorKinds` (as a
 * stable signal of "what tends to break for this user") but not toward the
 * recency-weighted rate.
 */
export function computeFailureFingerprint(signals: LearningSignalRow[], now = new Date()): FailureFingerprint {
  const counts = new Map<string, number>();
  let recent = 0;
  let recentFailures = 0;
  const failureWindowStart = new Date(now.getTime() - FAILURE_WINDOW_DAYS * MS_PER_DAY);

  for (const sig of signals) {
    const ts = safeDate(sig.createdAt);
    if (!ts) continue;
    if (sig.status === 'FAILED' && sig.errorKind) {
      counts.set(sig.errorKind, (counts.get(sig.errorKind) ?? 0) + 1);
    }
    if (ts >= failureWindowStart) {
      recent += 1;
      if (sig.status === 'FAILED') recentFailures += 1;
    }
  }

  const topErrorKinds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([kind, count]) => ({ kind, count }));

  return {
    topErrorKinds,
    failureRate7d: recent === 0 ? 0 : recentFailures / recent,
    samples: recent,
  };
}

/** Counts of each WorkflowIntent over the input window. */
export function computeIntentMix(signals: LearningSignalRow[]): IntentMix {
  const out: IntentMix = {};
  for (const sig of signals) {
    const intent = sig.intent ?? sig.workflow;
    if (!intent) continue;
    const key = String(intent);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * Suggest a tone mode based on observed personality_mode distribution and
 * correction_applied signals. Conservative: only returns a non-`'normal'`
 * suggestion when ≥20 samples and the dominant mode beats 70% of all samples.
 * Caller is responsible for honoring operator-set tone — this function only
 * suggests, it does not write.
 */
export function computeResponseStyle(signals: LearningSignalRow[]): ResponseStyleSuggestion {
  const counts = new Map<PersonalityMode, number>();
  let samples = 0;
  for (const sig of signals) {
    const mode = sig.personalityMode;
    if (mode !== 'normal' && mode !== 'terse' && mode !== 'technical' && mode !== 'casual') continue;
    counts.set(mode, (counts.get(mode) ?? 0) + 1);
    samples += 1;
  }
  if (samples < 20) {
    return { suggestedMode: 'normal', confidence: 0, samples };
  }
  let bestMode: PersonalityMode = 'normal';
  let bestCount = 0;
  for (const [mode, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestMode = mode;
    }
  }
  const confidence = bestCount / samples;
  if (bestMode === 'normal' || confidence < 0.7) {
    return { suggestedMode: 'normal', confidence, samples };
  }
  return { suggestedMode: bestMode, confidence, samples };
}

/** UTC hour with the most signals; null if no parseable timestamps. */
export function computeActiveHours(signals: LearningSignalRow[]): ActiveHours {
  const buckets = new Array<number>(24).fill(0);
  let samples = 0;
  for (const sig of signals) {
    const ts = safeDate(sig.createdAt);
    if (!ts) continue;
    buckets[ts.getUTCHours()] += 1;
    samples += 1;
  }
  if (samples === 0) return { busiestHourUtc: null, samples: 0 };
  let busiestHourUtc = 0;
  let max = -1;
  for (let h = 0; h < 24; h++) {
    if (buckets[h] > max) {
      max = buckets[h];
      busiestHourUtc = h;
    }
  }
  return { busiestHourUtc, samples };
}
