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
        description="A centered control-room read on sidecar health, queue pressure, learning activity, and the next places worth your attention."
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
          subtitle="A tight preview of the highest-priority guidance generated from current runtime behavior."
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
          subtitle="The in-flight queue, surfaced in a quieter layout before you jump into the full run workspace."
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
          subtitle="Signals, corrections, and the default reply style without leaving the overview page."
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
            <MetricCard label="Reply Profiles" value={data?.learning.personalityProfiles ?? 0} />
            <MetricCard
              label="Reply Style"
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
          subtitle="Where workload and failure pressure are concentrating right now."
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
