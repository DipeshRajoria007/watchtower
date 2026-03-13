import type { DashboardData, JobLogEntry, RunSummary, RunsSubView } from '../types';
import {
  EmptyState,
  LiveLogConsole,
  MetricCard,
  PageIntro,
  RunInspector,
  RunList,
  SectionCard,
  StatusBadge,
  TabBar,
} from '../components/primitives';
import { getStatusTone } from '../lib/formatters';
import { AgentPipelineView } from '../components/AgentPipelineView';

type PipelineRunData = {
  id: string;
  jobId: string;
  status: string;
  steps: Array<{
    role: string;
    status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
    durationMs: number;
    findings: Array<{
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
      category: string;
      message: string;
      file?: string;
      line?: number;
      suggestion?: string;
    }>;
  }>;
  retryLoops: number;
  totalDurationMs: number | null;
};

type RunsPageProps = {
  data: DashboardData | null;
  liveSidecarLogs: string[];
  onSubViewChange: (view: RunsSubView) => void;
  onSelectRun: (runId: string) => void;
  runsSubView: RunsSubView;
  selectedRun: RunSummary | null;
  selectedRunId: string | null;
  selectedRunLogs: JobLogEntry[];
  selectedRunPipeline?: PipelineRunData | null;
};

export function RunsPage({
  data,
  liveSidecarLogs,
  onSubViewChange,
  onSelectRun,
  runsSubView,
  selectedRun,
  selectedRunId,
  selectedRunLogs,
  selectedRunPipeline,
}: RunsPageProps) {
  const tabs = [
    { label: 'Active', value: 'active' as const, count: data?.activeJobs.length ?? 0 },
    { label: 'Failures', value: 'failures' as const, count: data?.failures.length ?? 0 },
    { label: 'Recent', value: 'recent' as const, count: data?.recentRuns.length ?? 0 },
    { label: 'Diagnostics', value: 'diagnostics' as const, count: liveSidecarLogs.length },
  ];

  const runCollections = {
    active: data?.activeJobs ?? [],
    failures: data?.failures ?? [],
    recent: data?.recentRuns ?? [],
  };

  const currentRuns = runsSubView === 'diagnostics' ? [] : runCollections[runsSubView];

  const sectionTitles = {
    active: 'Active Queue',
    failures: 'Failures Queue',
    recent: 'Recent Queue',
  };

  const sectionDescriptions = {
    active: 'In-flight workflow executions.',
    failures: 'Runs that require manual attention.',
    recent: 'Most recent completed and failed executions.',
  };

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Operational Workspace"
        title="Runs"
        description="Move between active work, failures, recent history, and live diagnostics without losing the selected run or its trace context."
        actions={
          selectedRun ? (
            <StatusBadge label={selectedRun.status} tone={getStatusTone(selectedRun.status)} />
          ) : undefined
        }
      />

      <section className="stats-grid runs-stats">
        <MetricCard label="Active" value={data?.activeJobs.length ?? 0} tone="accent" />
        <MetricCard label="Failures" value={data?.failures.length ?? 0} tone={(data?.failures.length ?? 0) > 0 ? 'danger' : 'success'} />
        <MetricCard label="Recent" value={data?.recentRuns.length ?? 0} />
        <MetricCard label="Selected Trace" value={selectedRunLogs.length} tone="warning" />
      </section>

      <TabBar tabs={tabs} value={runsSubView} onChange={onSubViewChange} />

      {runsSubView === 'diagnostics' ? (
        <section className="panel-grid diagnostics-grid">
          <SectionCard
            title="Selected Run Context"
            subtitle="The same selection follows you across queue views and the live diagnostics console."
            count={selectedRun ? 1 : 0}
          >
            {selectedRun ? (
              <div className="diagnostics-context">
                <div className="detail-grid">
                  <div>
                    <span>Workflow</span>
                    <strong>{selectedRun.workflow}</strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <strong>{selectedRun.status}</strong>
                  </div>
                  <div>
                    <span>Job ID</span>
                    <strong>{selectedRun.id}</strong>
                  </div>
                  <div>
                    <span>Trace Entries</span>
                    <strong>{selectedRunLogs.length}</strong>
                  </div>
                </div>
                {selectedRun.errorMessage ? <p className="detail-error">{selectedRun.errorMessage}</p> : null}
              </div>
            ) : (
              <EmptyState>Select a run from Active, Failures, or Recent to pin context here.</EmptyState>
            )}
          </SectionCard>

          <SectionCard
            title="Live Sidecar Stream"
            subtitle="Buffered stdout and stderr that stay visible while you move through the rest of the app."
            count={liveSidecarLogs.length}
          >
            <LiveLogConsole lines={liveSidecarLogs} />
          </SectionCard>
        </section>
      ) : (
        <section className="runs-workspace">
          <SectionCard
            title={sectionTitles[runsSubView]}
            subtitle={sectionDescriptions[runsSubView]}
            count={currentRuns.length}
          >
            <RunList
              runs={currentRuns}
              empty={
                runsSubView === 'active'
                  ? 'No active jobs.'
                  : runsSubView === 'failures'
                    ? 'No failed jobs.'
                    : 'No recent jobs.'
              }
              selectedRunId={selectedRunId}
              onSelect={onSelectRun}
            />
          </SectionCard>

          <RunInspector run={selectedRun} logs={selectedRunLogs} />
          {selectedRunPipeline && <AgentPipelineView pipelineRun={selectedRunPipeline} />}
        </section>
      )}
    </div>
  );
}
