import { getSidecarTone, humanizeMode, humanizeToken } from '../lib/formatters';
import type { DashboardData, RunsSubView } from '../types';
import {
  ChannelHeatList,
  MetricCard,
  PageIntro,
  RecommendationList,
  RunList,
  SectionCard,
  StatusBadge,
} from '../components/primitives';

type OverviewPageProps = {
  data: DashboardData | null;
  onOpenIntelligence: () => void;
  onOpenRuns: (subView: RunsSubView) => void;
  onOpenSettings: () => void;
  onSelectRun: (runId: string) => void;
};

export function OverviewPage({
  data,
  onOpenIntelligence,
  onOpenRuns,
  onOpenSettings,
  onSelectRun,
}: OverviewPageProps) {
  const sidecarStatus = data?.sidecarStatus ?? 'starting';
  const sidecarTone = getSidecarTone(sidecarStatus);

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Operating Snapshot"
        title="Overview"
        description="Condensed health, queue pressure, and preview cards for the parts of Watchtower you need to monitor all day."
        actions={
          <div className="header-chip-row">
            <StatusBadge label={humanizeToken(sidecarStatus)} tone={sidecarTone === 'good' ? 'success' : sidecarTone === 'danger' ? 'failed' : sidecarTone === 'warn' ? 'warn' : 'info'} />
            {!data?.settingsConfigured ? (
              <button className="ghost-button" type="button" onClick={onOpenSettings}>
                Complete Settings
              </button>
            ) : null}
          </div>
        }
      />

      <section className="stats-grid overview-stats">
        <MetricCard label="Sidecar Health" value={humanizeToken(sidecarStatus)} tone={sidecarTone === 'good' ? 'success' : sidecarTone === 'danger' ? 'danger' : sidecarTone === 'warn' ? 'warning' : 'neutral'} />
        <MetricCard label="Active Jobs" value={data?.activeJobs.length ?? 0} tone="accent" />
        <MetricCard label="Failures" value={data?.failures.length ?? 0} tone={(data?.failures.length ?? 0) > 0 ? 'danger' : 'success'} />
        <MetricCard label="24h Success" value={`${data?.metrics.successRate24h ?? 0}%`} tone="success" />
        <MetricCard label="Success Streak" value={data?.metrics.successStreak ?? 0} tone="accent" />
      </section>

      <section className="panel-grid overview-grid">
        <SectionCard
          title="Top Recommendations"
          subtitle="Preview only. Open Intelligence for the full learning workspace."
          count={data?.recommendations.length ?? 0}
          actions={
            <button className="ghost-button" type="button" onClick={onOpenIntelligence}>
              Open Intelligence
            </button>
          }
        >
          <RecommendationList
            recommendations={data?.recommendations ?? []}
            limit={3}
            empty="No recommendations have been generated yet."
          />
        </SectionCard>

        <SectionCard
          title="Active Jobs Preview"
          subtitle="Most recent in-flight work. Open Runs for the full master-detail workspace."
          count={data?.activeJobs.length ?? 0}
          actions={
            <button className="ghost-button" type="button" onClick={() => onOpenRuns('active')}>
              Open Runs
            </button>
          }
        >
          <RunList
            runs={(data?.activeJobs ?? []).slice(0, 4)}
            empty="No active jobs. Watchtower is idle and waiting for Slack."
            onSelect={runId => {
              onSelectRun(runId);
              onOpenRuns('active');
            }}
          />
        </SectionCard>

        <SectionCard
          title="Learning Snapshot"
          subtitle="A condensed view of the adaptive layer."
          count={data?.learning.personalityProfiles ?? 0}
          actions={
            <button className="ghost-button" type="button" onClick={onOpenIntelligence}>
              Explore Signals
            </button>
          }
        >
          <div className="overview-learning-grid">
            <MetricCard label="Signals 24h" value={data?.learning.signals24h ?? 0} />
            <MetricCard label="Corrections Applied" value={data?.learning.correctionsApplied24h ?? 0} tone="success" />
            <MetricCard label="Profiles" value={data?.learning.personalityProfiles ?? 0} />
            <MetricCard
              label="Dominant Mode"
              value={humanizeMode(data?.learning.dominantPersonalityMode ?? '')}
              tone="accent"
            />
          </div>
          <div className="snapshot-strip">
            <span>Top failure signature</span>
            <strong>
              {data?.learning.topFailureKind && data.learning.topFailureKind !== 'none'
                ? `${data.learning.topFailureKind} (${data.learning.topFailureCount})`
                : 'None'}
            </strong>
          </div>
        </SectionCard>

        <SectionCard
          title="Channel Heat Snapshot"
          subtitle="Highest-traffic channels for current operations."
          count={data?.channelHeat.length ?? 0}
          actions={
            <button className="ghost-button" type="button" onClick={onOpenIntelligence}>
              Full Heat Map
            </button>
          }
        >
          <ChannelHeatList
            channels={data?.channelHeat ?? []}
            limit={4}
            empty="No channel heat has been recorded yet."
          />
        </SectionCard>
      </section>
    </div>
  );
}
