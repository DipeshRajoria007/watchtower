import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GroupedAggregate, PerformanceOverview, TopRun } from '../types';
import { GlowCard } from '../components/GlowCard';
import { PageIntro } from '../components/primitives';
import { formatCostUsd, formatDurationMs, formatPercent, formatTimestamp, formatTokens } from '../lib/formatters';

type RangeKey = '24h' | '7d' | '30d' | 'all';

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: '24h', label: 'Last 24h' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
];

function rangeToSinceIso(range: RangeKey): string {
  if (range === 'all') return '1970-01-01T00:00:00.000Z';
  const now = Date.now();
  const lookback =
    range === '24h' ? 24 * 60 * 60 * 1000 : range === '7d' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  return new Date(now - lookback).toISOString();
}

function nowIso(): string {
  // small forward bias so very recent rows aren't excluded by clock skew
  return new Date(Date.now() + 60_000).toISOString();
}

type PerformancePageProps = {
  onSelectRun: (jobId: string) => void;
  onNavigateRuns: () => void;
};

export function PerformancePage({ onSelectRun, onNavigateRuns }: PerformancePageProps) {
  const [range, setRange] = useState<RangeKey>('24h');
  const [overview, setOverview] = useState<PerformanceOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<PerformanceOverview>('get_performance_overview', {
      sinceIso: rangeToSinceIso(range),
      untilIso: nowIso(),
    })
      .then(data => {
        if (!cancelled) setOverview(data);
      })
      .catch(err => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const maxByWorkflowCost = useMemo(() => {
    if (!overview || overview.byWorkflow.length === 0) return 0;
    return Math.max(...overview.byWorkflow.map(g => g.totalCostUsd));
  }, [overview]);

  const maxByModelCost = useMemo(() => {
    if (!overview || overview.byBackendModel.length === 0) return 0;
    return Math.max(...overview.byBackendModel.map(g => g.totalCostUsd));
  }, [overview]);

  const handleRunClick = (jobId: string) => {
    onSelectRun(jobId);
    onNavigateRuns();
  };

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Cost & Latency"
        title="Performance"
        description="Token usage, cost, and wall-clock latency across every agent invocation."
      />

      <GlowCard>
        <section className="surface-card">
          <div className="section-head">
            <div className="section-heading-copy">
              <div className="section-title-row">
                <h2>Headline</h2>
              </div>
              <p className="muted">Aggregates across the selected window</p>
            </div>
            <div className="performance-range-toggle">
              {RANGES.map(option => (
                <button
                  key={option.key}
                  type="button"
                  className={range === option.key ? 'range-button active' : 'range-button'}
                  onClick={() => setRange(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {error ? <div className="inline-error-banner">{error}</div> : null}
          {loading && !overview ? <p className="muted">Loading…</p> : null}

          {overview ? (
            <div className="detail-grid">
              <div>
                <span>Total cost</span>
                <strong>{formatCostUsd(overview.totalCostUsd)}</strong>
              </div>
              <div>
                <span>Calls</span>
                <strong>{overview.totalCalls}</strong>
              </div>
              <div>
                <span>Avg cost / run</span>
                <strong>{formatCostUsd(overview.avgCostPerRunUsd)}</strong>
              </div>
              <div>
                <span>Input tokens</span>
                <strong>{formatTokens(overview.totalInputTokens)}</strong>
              </div>
              <div>
                <span>Output tokens</span>
                <strong>{formatTokens(overview.totalOutputTokens)}</strong>
              </div>
              <div>
                <span>Cache hit</span>
                <strong>{formatPercent(overview.cacheHitRate)}</strong>
              </div>
            </div>
          ) : null}
        </section>
      </GlowCard>

      {overview ? (
        <GlowCard>
          <section className="surface-card">
            <div className="section-head">
              <div className="section-heading-copy">
                <div className="section-title-row">
                  <h2>By workflow</h2>
                  <span className="section-count">{overview.byWorkflow.length}</span>
                </div>
                <p className="muted">Cost, calls, and average duration grouped by workflow type</p>
              </div>
            </div>
            <GroupedTable rows={overview.byWorkflow} max={maxByWorkflowCost} keyHeading="Workflow" />
          </section>
        </GlowCard>
      ) : null}

      {overview ? (
        <GlowCard>
          <section className="surface-card">
            <div className="section-head">
              <div className="section-heading-copy">
                <div className="section-title-row">
                  <h2>By backend &amp; model</h2>
                  <span className="section-count">{overview.byBackendModel.length}</span>
                </div>
                <p className="muted">Where the budget actually goes</p>
              </div>
            </div>
            <GroupedTable rows={overview.byBackendModel} max={maxByModelCost} keyHeading="Backend : model" />
          </section>
        </GlowCard>
      ) : null}

      {overview ? (
        <GlowCard>
          <section className="surface-card">
            <div className="section-head">
              <div className="section-heading-copy">
                <div className="section-title-row">
                  <h2>Top runs by cost</h2>
                  <span className="section-count">{overview.topRuns.length}</span>
                </div>
                <p className="muted">Click a row to open it in the Runs detail view</p>
              </div>
            </div>
            <TopRunsTable rows={overview.topRuns} onSelect={handleRunClick} />
          </section>
        </GlowCard>
      ) : null}
    </div>
  );
}

function GroupedTable({ rows, max, keyHeading }: { rows: GroupedAggregate[]; max: number; keyHeading: string }) {
  if (rows.length === 0) {
    return <p className="muted">No data in this window.</p>;
  }
  return (
    <div className="cost-table-scroll">
      <table className="cost-table">
        <thead>
          <tr>
            <th>{keyHeading}</th>
            <th className="num">Calls</th>
            <th className="num">Total cost</th>
            <th className="num">Avg cost</th>
            <th className="num">Avg duration</th>
            <th>Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const pct = max > 0 ? (row.totalCostUsd / max) * 100 : 0;
            return (
              <tr key={row.key}>
                <td>{row.key}</td>
                <td className="num">{row.calls}</td>
                <td className="num">{formatCostUsd(row.totalCostUsd)}</td>
                <td className="num">{formatCostUsd(row.avgCostUsd)}</td>
                <td className="num">{formatDurationMs(row.avgDurationMs)}</td>
                <td>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TopRunsTable({ rows, onSelect }: { rows: TopRun[]; onSelect: (jobId: string) => void }) {
  if (rows.length === 0) {
    return <p className="muted">No runs in this window.</p>;
  }
  return (
    <div className="cost-table-scroll">
      <table className="cost-table">
        <thead>
          <tr>
            <th>Started</th>
            <th>Workflow</th>
            <th>Status</th>
            <th className="num">Calls</th>
            <th className="num">Duration</th>
            <th className="num">Input</th>
            <th className="num">Output</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.jobId} className="row-clickable" onClick={() => onSelect(row.jobId)}>
              <td>{formatTimestamp(row.startedAt)}</td>
              <td>{row.workflow}</td>
              <td>{row.status}</td>
              <td className="num">{row.callCount}</td>
              <td className="num">{formatDurationMs(row.durationMs)}</td>
              <td className="num">{formatTokens(row.inputTokens)}</td>
              <td className="num">{formatTokens(row.outputTokens)}</td>
              <td className="num">{formatCostUsd(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
