import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-store-')), 'watchtower.db');
}

describe('jobStore.agent_calls', () => {
  it('records calls and aggregates them per job', () => {
    const store = new JobStore(tempDbPath());
    const jobId = 'job-1';

    store.recordAgentCall({
      jobId,
      pipelineRunId: 'pr-1',
      role: 'planner',
      backend: 'claude-code',
      model: 'claude-sonnet-4-20250514',
      durationMs: 1500,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheCreationTokens: 0,
      costUsd: 0.012,
      costSource: 'reported',
      ok: true,
    });
    store.recordAgentCall({
      jobId,
      pipelineRunId: 'pr-1',
      role: 'coder',
      backend: 'claude-code',
      model: 'claude-opus-4-20250514',
      durationMs: 4500,
      inputTokens: 3000,
      outputTokens: 1200,
      cacheReadTokens: 1500,
      cacheCreationTokens: 200,
      costUsd: 0.18,
      costSource: 'reported',
      ok: true,
    });

    const summary = store.getJobCallSummary(jobId);
    expect(summary.callCount).toBe(2);
    expect(summary.totalCostUsd).toBeCloseTo(0.192, 6);
    expect(summary.totalDurationMs).toBe(6000);
    expect(summary.totalInputTokens).toBe(4000);
    expect(summary.totalOutputTokens).toBe(1400);
    expect(summary.totalCacheReadTokens).toBe(2000);
    expect(summary.calls.map(c => c.role)).toEqual(['planner', 'coder']);
  });

  it('returns empty summary for a job with no calls', () => {
    const store = new JobStore(tempDbPath());
    const summary = store.getJobCallSummary('missing');
    expect(summary.callCount).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.calls).toEqual([]);
  });

  it('aggregates a 24h window via getCallSummarySince', () => {
    const store = new JobStore(tempDbPath());
    const since = new Date(Date.now() - 60 * 1000).toISOString();

    store.recordAgentCall({
      jobId: 'j1',
      backend: 'claude-code',
      model: 'claude-sonnet-4-20250514',
      durationMs: 1000,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 1000,
      costUsd: 0.01,
      costSource: 'reported',
      ok: true,
    });
    store.recordAgentCall({
      jobId: 'j2',
      backend: 'codex',
      model: 'gpt-5.4',
      durationMs: 2000,
      inputTokens: 2000,
      outputTokens: 500,
      costUsd: 0.04,
      costSource: 'computed',
      ok: true,
    });

    const window = store.getCallSummarySince(since);
    expect(window.totalCalls).toBe(2);
    expect(window.totalCostUsd).toBeCloseTo(0.05, 6);
    expect(window.totalInputTokens).toBe(3000);
    expect(window.totalOutputTokens).toBe(600);
    expect(window.totalCacheReadTokens).toBe(1000);
    // cache hit rate = cache_read / (input + cache_read) = 1000 / 4000 = 0.25
    expect(window.cacheHitRate).toBeCloseTo(0.25, 6);
  });

  it('listCallsBetween bounds rows by createdAt window', () => {
    const store = new JobStore(tempDbPath());
    const farPast = '1970-01-01T00:00:00.000Z';
    const farFuture = '2999-01-01T00:00:00.000Z';

    store.recordAgentCall({
      jobId: 'j-window',
      backend: 'claude-code',
      durationMs: 100,
      ok: true,
    });

    const all = store.listCallsBetween(farPast, farFuture);
    expect(all.length).toBe(1);

    const future = store.listCallsBetween('2999-01-01T00:00:00.000Z', '2999-12-31T00:00:00.000Z');
    expect(future.length).toBe(0);
  });
});
