import type { ReactNode } from "react";
import {
  formatDurationSeconds,
  formatTimestamp,
  getPriorityTone,
  getStatusTone,
  humanizeMode,
  prettyJson,
} from "../lib/formatters";
import type {
  ChannelHeat,
  DashboardMetrics,
  DashboardRecommendation,
  JobLogEntry,
  LearningInsights,
  RunSummary,
} from "../types";

type SectionCardProps = {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  count?: number | string;
  subtitle?: string;
  title: string;
};

export function PageIntro({
  eyebrow,
  title,
  description,
  actions,
}: {
  actions?: ReactNode;
  description: string;
  eyebrow: string;
  title: string;
}) {
  return (
    <header className="page-intro">
      <div className="page-intro-copy">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>

      <div className="page-intro-visual" aria-hidden="true">
        <span className="page-intro-ring page-intro-ring-outer" />
        <span className="page-intro-ring page-intro-ring-mid" />
        <span className="page-intro-ring page-intro-ring-inner" />
        <span className="page-intro-core" />
      </div>
    </header>
  );
}

export function SectionCard({
  actions,
  children,
  className,
  count,
  subtitle,
  title,
}: SectionCardProps) {
  return (
    <section
      className={className ? `surface-card ${className}` : "surface-card"}
    >
      <div className="section-head">
        <div className="section-heading-copy">
          <div className="section-title-row">
            <h2>{title}</h2>
            {count !== undefined ? (
              <span className="section-count">{count}</span>
            ) : null}
          </div>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
        </div>

        {actions ? (
          <div className="section-head-actions">
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function MetricCard({
  className,
  detail,
  label,
  tone = "neutral",
  value,
  valueTitle,
  variant = "default",
}: {
  className?: string;
  detail?: string;
  label: string;
  tone?: "accent" | "danger" | "neutral" | "success" | "warning";
  value: ReactNode;
  valueTitle?: string;
  variant?: "compact" | "default";
}) {
  return (
    <article
      className={
        className
          ? `metric-card metric-${tone} metric-${variant} ${className}`
          : `metric-card metric-${tone} metric-${variant}`
      }
    >
      <span className="metric-label">{label}</span>
      <strong className="metric-value" title={valueTitle}>
        {value}
      </strong>
      {detail ? <p className="metric-detail">{detail}</p> : null}
    </article>
  );
}

export function StatusBadge({
  label,
  tone = "info",
}: {
  label: string;
  tone?: string;
}) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty-state">{children}</p>;
}

export function TabBar<T extends string>({
  onChange,
  tabs,
  value,
}: {
  onChange: (value: T) => void;
  tabs: Array<{ count?: number | string; label: string; value: T }>;
  value: T;
}) {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          className={tab.value === value ? "tab-button active" : "tab-button"}
          type="button"
          onClick={() => onChange(tab.value)}
        >
          <span>{tab.label}</span>
          {tab.count !== undefined ? (
            <span className="tab-count">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function RunList({
  empty,
  onSelect,
  runs,
  selectedRunId,
}: {
  empty: string;
  onSelect?: (runId: string) => void;
  runs: RunSummary[];
  selectedRunId?: string | null;
}) {
  if (runs.length === 0) {
    return <EmptyState>{empty}</EmptyState>;
  }

  return (
    <ul className="run-list">
      {runs.map((run) => {
        const selected = run.id === selectedRunId;
        return (
          <li key={run.id}>
            <button
              type="button"
              className={selected ? "run-card selected" : "run-card"}
              onClick={() => onSelect?.(run.id)}
            >
              <div className="run-card-top">
                <div className="run-card-copy">
                  <span className="run-card-workflow">
                    {run.workflow.replaceAll("_", " ")}
                  </span>
                  <span className="run-card-title">{run.taskSummary}</span>
                </div>
                <StatusBadge
                  label={run.status}
                  tone={getStatusTone(run.status)}
                />
              </div>
              <div className="run-card-meta">
                <span>Updated {formatTimestamp(run.updatedAt)}</span>
              </div>
              {run.errorMessage ? (
                <p className="run-card-error">{run.errorMessage}</p>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function RunInspector({
  logs,
  onReviewChanges,
  run,
}: {
  logs: JobLogEntry[];
  onReviewChanges?: (runId: string) => void;
  run: RunSummary | null;
}) {
  if (!run) {
    return (
      <EmptyState>
        Select a run to inspect its metadata and execution trace.
      </EmptyState>
    );
  }

  return (
    <div className="inspector-stack">
      <article className="surface-card detail-card">
        <div className="detail-header">
          <div className="detail-header-copy">
            <span className="eyebrow">{run.workflow.replaceAll("_", " ")}</span>
            <h2>{run.taskSummary}</h2>
          </div>
          <StatusBadge label={run.status} tone={getStatusTone(run.status)} />
        </div>

        <div className="detail-grid">
          <div>
            <span>Job ID</span>
            <strong>{run.id}</strong>
          </div>
          <div>
            <span>Channel</span>
            <strong>{run.channelId}</strong>
          </div>
          <div>
            <span>Thread</span>
            <strong>{run.threadTs}</strong>
          </div>
          <div>
            <span>Created</span>
            <strong>{formatTimestamp(run.createdAt)}</strong>
          </div>
          <div>
            <span>Updated</span>
            <strong>{formatTimestamp(run.updatedAt)}</strong>
          </div>
          <div>
            <span>Trace Entries</span>
            <strong>{logs.length}</strong>
          </div>
        </div>

        {run.errorMessage ? (
          <p className="detail-error">{run.errorMessage}</p>
        ) : null}

        {run.workflow === "PM_TASK" &&
        run.status === "SUCCESS" &&
        onReviewChanges ? (
          <button
            className="primary-button"
            type="button"
            onClick={() => onReviewChanges(run.id)}
          >
            Review Changes
          </button>
        ) : null}
      </article>

      <SectionCard
        title="Execution Trace"
        subtitle={`Persisted trace for ${run.id}`}
        count={logs.length}
      >
        <TraceList logs={logs} selectedRun={run} />
      </SectionCard>
    </div>
  );
}

export function TraceList({
  logs,
  selectedRun,
}: {
  logs: JobLogEntry[];
  selectedRun: RunSummary | null;
}) {
  if (!selectedRun) {
    return (
      <EmptyState>
        Select a run from the list to inspect detailed step logs.
      </EmptyState>
    );
  }

  if (logs.length === 0) {
    return (
      <EmptyState>
        No trace entries have been persisted for this run yet.
      </EmptyState>
    );
  }

  return (
    <ul className="trace-list">
      {logs.map((log) => (
        <li key={log.id}>
          <div className="trace-top">
            <StatusBadge label={log.level} tone={getStatusTone(log.level)} />
            <span className="trace-stage">{log.stage}</span>
            <span className="trace-time">{formatTimestamp(log.createdAt)}</span>
          </div>
          <div className="trace-message">{log.message}</div>
          {log.dataJson ? (
            <pre className="trace-data">{prettyJson(log.dataJson)}</pre>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function LiveLogConsole({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return <EmptyState>Waiting for sidecar log output.</EmptyState>;
  }

  return (
    <div className="live-log-console" role="log" aria-live="polite">
      {lines.map((line, index) => (
        <div key={`${index}-${line.slice(0, 30)}`}>{line}</div>
      ))}
    </div>
  );
}

export function RecommendationList({
  empty,
  limit,
  recommendations,
}: {
  empty?: string;
  limit?: number;
  recommendations: DashboardRecommendation[];
}) {
  const items = limit ? recommendations.slice(0, limit) : recommendations;
  if (items.length === 0) {
    return (
      <EmptyState>{empty ?? "No recommendations generated yet."}</EmptyState>
    );
  }

  return (
    <ul className="recommendation-list">
      {items.map((item) => (
        <li key={item.id}>
          <div className="recommendation-top">
            <strong>{item.title}</strong>
            <StatusBadge
              label={item.priority}
              tone={getPriorityTone(item.priority)}
            />
          </div>
          <p className="recommendation-body">{item.detail}</p>
        </li>
      ))}
    </ul>
  );
}

export function PulseMetrics({ metrics }: { metrics: DashboardMetrics }) {
  return (
    <div className="pulse-grid">
      <MetricCard
        label="24h Success"
        value={`${metrics.successRate24h}%`}
        tone="success"
        variant="compact"
      />
      <MetricCard label="24h Runs" value={metrics.runs24h} variant="compact" />
      <MetricCard
        label="24h Failures"
        value={metrics.failedRuns24h}
        tone="danger"
        variant="compact"
      />
      <MetricCard
        label="Avg Resolution"
        value={formatDurationSeconds(metrics.avgResolutionSeconds24h)}
        variant="compact"
      />
      <MetricCard
        label="Catch-up Wins"
        value={metrics.catchupRecovered24h}
        tone={metrics.catchupRecovered24h > 0 ? "accent" : "neutral"}
        variant="compact"
      />
      <MetricCard
        label="Unknown 24h"
        value={metrics.unknownTasks24h}
        tone={metrics.unknownTasks24h > 0 ? "warning" : "neutral"}
        variant="compact"
      />
      <MetricCard
        label="Success Streak"
        value={metrics.successStreak}
        tone={metrics.successStreak > 0 ? "success" : "neutral"}
        variant="compact"
      />
      <MetricCard
        label="Chaos Index"
        value={metrics.chaosIndex}
        tone={metrics.chaosIndex > 0 ? "warning" : "neutral"}
        variant="compact"
      />
    </div>
  );
}

export function ChannelHeatList({
  channels,
  empty,
  limit,
}: {
  channels: ChannelHeat[];
  empty?: string;
  limit?: number;
}) {
  const items = limit ? channels.slice(0, limit) : channels;
  if (items.length === 0) {
    return <EmptyState>{empty ?? "No channel activity yet."}</EmptyState>;
  }

  return (
    <ul className="channel-heat-list">
      {items.map((channel) => (
        <li key={channel.channelId}>
          <strong className="channel-id">{channel.channelId}</strong>
          <div className="channel-runs">{channel.runs} runs</div>
          <StatusBadge
            label={`${channel.failures} failures`}
            tone={channel.failures > 0 ? "warn" : "success"}
          />
        </li>
      ))}
    </ul>
  );
}

export function LearningInsightsPanel({
  learning,
}: {
  learning: LearningInsights;
}) {
  const dominantMode = humanizeMode(learning.dominantPersonalityMode);
  const topFailure =
    learning.topFailureKind === "none"
      ? "None"
      : `${learning.topFailureKind} (${learning.topFailureCount})`;

  return (
    <div className="learning-stack">
      <div className="learning-metrics learning-metrics-primary">
        <MetricCard
          label="Signals 24h"
          value={learning.signals24h}
          variant="compact"
        />
        <MetricCard
          label="Corrections Learned"
          value={learning.correctionsLearned}
          tone={learning.correctionsLearned > 0 ? "accent" : "neutral"}
          variant="compact"
        />
        <MetricCard
          label="Corrections Applied"
          value={learning.correctionsApplied24h}
          tone={learning.correctionsApplied24h > 0 ? "success" : "neutral"}
          variant="compact"
        />
        <MetricCard
          label="Reply Profiles"
          value={learning.personalityProfiles}
          variant="compact"
        />
      </div>

      <div className="learning-highlights">
        <MetricCard
          label="Reply Style"
          value={dominantMode}
          tone="accent"
          variant="compact"
          className="metric-highlight"
        />
        <MetricCard
          label="Top Failure Signature"
          value={topFailure}
          tone={learning.topFailureKind === "none" ? "neutral" : "warning"}
          variant="compact"
          className="metric-highlight metric-value-wrap"
          valueTitle={topFailure}
        />
      </div>

      {learning.profilesByMode.length > 1 ? (
        <div className="learning-mode-section">
          <div className="section-label">Profiles by Reply Style</div>
          <div className="mode-heat-grid">
            {learning.profilesByMode.map((mode) => (
              <article className="mode-card" key={mode.mode}>
                <span>{humanizeMode(mode.mode)}</span>
                <strong>{mode.count}</strong>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
