import { useEffect, useMemo, useState } from 'react';
import type { DashboardData, JobLogEntry, PipelineRunData, RunSummary } from '../types';
import {
  LiveLogConsole,
  PageIntro,
  RunsFilterBar,
  RunsTable,
  ShellTraceView,
  SlackMarkdown,
  StatusBadge,
  WorkflowGraph,
} from '../components/primitives';
import type { SortDirection, SortField } from '../components/primitives';
import { formatTimestamp, getStatusTone } from '../lib/formatters';
import { AgentPipelineView } from '../components/AgentPipelineView';
import { GlowCard } from '../components/GlowCard';

type RunsPageProps = {
  data: DashboardData | null;
  liveSidecarLogs: string[];
  onReviewChanges?: (runId: string) => void;
  onSelectRun: (runId: string) => void;
  selectedRunId: string | null;
  selectedRunLogs: JobLogEntry[];
  selectedRunPipeline?: PipelineRunData | null;
};

export function RunsPage({
  data,
  liveSidecarLogs,
  onReviewChanges,
  onSelectRun,
  selectedRunId,
  selectedRunLogs,
  selectedRunPipeline,
}: RunsPageProps) {
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('updatedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [activeStage, setActiveStage] = useState<string | null>(null);

  const allRuns = useMemo(() => {
    if (!data) return [] as RunSummary[];
    const map = new Map<string, RunSummary>();
    for (const run of [...data.activeJobs, ...data.recentRuns, ...data.failures]) {
      map.set(run.id, run);
    }
    return Array.from(map.values());
  }, [data]);

  const selectedRun = useMemo(() => {
    if (!detailRunId) return null;
    return allRuns.find(r => r.id === detailRunId) ?? null;
  }, [allRuns, detailRunId]);

  const filteredRuns = useMemo(() => {
    let runs = allRuns;

    if (statusFilter !== 'all') {
      runs = runs.filter(r => {
        const s = r.status.toLowerCase();
        if (statusFilter === 'running') return s.includes('run') || s.includes('progress') || s.includes('queue');
        if (statusFilter === 'success') return s.includes('success') || s.includes('done') || s.includes('complete');
        if (statusFilter === 'failed') return s.includes('fail') || s.includes('error');
        return true;
      });
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      runs = runs.filter(r => r.taskSummary.toLowerCase().includes(q) || r.workflow.toLowerCase().includes(q));
    }

    return [...runs].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'updatedAt') cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      else if (sortField === 'createdAt') cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      else if (sortField === 'status') cmp = a.status.localeCompare(b.status);
      else if (sortField === 'workflow') cmp = a.workflow.localeCompare(b.workflow);
      return sortDirection === 'desc' ? -cmp : cmp;
    });
  }, [allRuns, statusFilter, searchQuery, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDirection(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const handleSelectRun = (runId: string) => {
    setDetailRunId(runId);
    onSelectRun(runId);
  };

  useEffect(() => {
    if (!detailRunId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetailRunId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detailRunId]);

  // If navigated here with a selectedRunId from OverviewPage, open its detail
  useEffect(() => {
    if (selectedRunId && !detailRunId && allRuns.some(r => r.id === selectedRunId)) {
      setDetailRunId(selectedRunId);
    }
  }, []); // only on mount

  // Detail View
  if (detailRunId && selectedRun) {
    return (
      <div className="page-stack">
        <button className="ghost-button run-detail-back" type="button" onClick={() => setDetailRunId(null)}>
          &larr; Back to Runs
        </button>

        <GlowCard>
          <article className="surface-card detail-card">
            <div className="run-detail-header">
              <div className="run-detail-header-copy">
                <span className="eyebrow">{selectedRun.workflow.replaceAll('_', ' ')}</span>
                <h1>{selectedRun.taskSummary}</h1>
              </div>
              <div className="run-detail-header-actions">
                <StatusBadge label={selectedRun.status} tone={getStatusTone(selectedRun.status)} />
                {selectedRun.status === 'SUCCESS' && onReviewChanges ? (
                  <button className="primary-button" type="button" onClick={() => onReviewChanges(selectedRun.id)}>
                    Review Changes
                  </button>
                ) : null}
              </div>
            </div>

            <div className="detail-grid">
              <div>
                <span>Job ID</span>
                <strong>{selectedRun.id}</strong>
              </div>
              <div>
                <span>Channel</span>
                <strong>{selectedRun.channelId}</strong>
              </div>
              <div>
                <span>Thread</span>
                <strong>{selectedRun.threadTs}</strong>
              </div>
              <div>
                <span>Created</span>
                <strong>{formatTimestamp(selectedRun.createdAt)}</strong>
              </div>
              <div>
                <span>Updated</span>
                <strong>{formatTimestamp(selectedRun.updatedAt)}</strong>
              </div>
              <div>
                <span>Trace Entries</span>
                <strong>{selectedRunLogs.length}</strong>
              </div>
            </div>

            {selectedRun.errorMessage ? (
              <div className="detail-error">
                <SlackMarkdown text={selectedRun.errorMessage} />
              </div>
            ) : null}
          </article>
        </GlowCard>

        {selectedRunLogs.length > 0 ? (
          <GlowCard>
            <section className="surface-card">
              <div className="section-head">
                <div className="section-heading-copy">
                  <div className="section-title-row">
                    <h2>Workflow</h2>
                  </div>
                  <p className="muted">Pipeline stage progression</p>
                </div>
              </div>
              <WorkflowGraph
                logs={selectedRunLogs}
                pipelineRun={selectedRunPipeline}
                activeStage={activeStage}
                onStageClick={setActiveStage}
              />
            </section>
          </GlowCard>
        ) : null}

        <GlowCard>
          <section className="surface-card">
            <div className="section-head">
              <div className="section-heading-copy">
                <div className="section-title-row">
                  <h2>Execution Trace</h2>
                  <span className="section-count">{selectedRunLogs.length}</span>
                </div>
                <p className="muted">Terminal-style trace for {selectedRun.id}</p>
              </div>
            </div>
            <ShellTraceView logs={selectedRunLogs} highlightStage={activeStage} />
          </section>
        </GlowCard>

        {selectedRunPipeline ? <AgentPipelineView pipelineRun={selectedRunPipeline} /> : null}

        {liveSidecarLogs.length > 0 ? (
          <GlowCard>
            <section className="surface-card">
              <div className="section-head">
                <div className="section-heading-copy">
                  <div className="section-title-row">
                    <h2>Live Sidecar Stream</h2>
                    <span className="section-count">{liveSidecarLogs.length}</span>
                  </div>
                </div>
              </div>
              <LiveLogConsole lines={liveSidecarLogs} />
            </section>
          </GlowCard>
        ) : null}
      </div>
    );
  }

  // Table View
  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Operational Workspace"
        title="Runs"
        description="All workflow executions in one view. Click any row to inspect its trace and metadata."
      />

      <RunsFilterBar
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
      />

      <GlowCard>
        <section className="surface-card">
          <RunsTable
            runs={filteredRuns}
            onSelectRun={handleSelectRun}
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
          />
        </section>
      </GlowCard>
    </div>
  );
}
