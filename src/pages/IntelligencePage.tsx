import type { DashboardData } from '../types';
import {
  ChannelHeatList,
  LearningInsightsPanel,
  MetricCard,
  PageIntro,
  PulseMetrics,
  RecommendationList,
  SectionCard,
} from '../components/primitives';

export function IntelligencePage({ data }: { data: DashboardData | null }) {
  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Adaptive Layer"
        title="Intelligence"
        description="Full recommendations, learning metrics, personality mode heat, operations pulse, and channel activity live in one analytical workspace."
      />

      <section className="stats-grid intelligence-stats">
        <MetricCard label="Recommendations" value={data?.recommendations.length ?? 0} tone="accent" />
        <MetricCard label="Signals 24h" value={data?.learning.signals24h ?? 0} />
        <MetricCard label="Corrections Learned" value={data?.learning.correctionsLearned ?? 0} tone="success" />
        <MetricCard label="Tracked Channels" value={data?.channelHeat.length ?? 0} tone="warning" />
      </section>

      <section className="panel-grid intelligence-grid">
        <SectionCard
          title="Adaptive Intelligence"
          subtitle="Learning memory, self-correction, failure signatures, and personality profiles."
          count={data?.learning.profilesByMode.length ?? 0}
        >
          {data?.learning ? <LearningInsightsPanel learning={data.learning} /> : null}
        </SectionCard>

        <SectionCard
          title="Recommendations"
          subtitle="Generated from local runtime behavior."
          count={data?.recommendations.length ?? 0}
        >
          <RecommendationList recommendations={data?.recommendations ?? []} />
        </SectionCard>

        <SectionCard
          title="Ops Pulse"
          subtitle="Productivity, stability, and queue throughput across the last 24 hours."
          count={8}
        >
          {data?.metrics ? <PulseMetrics metrics={data.metrics} /> : null}
        </SectionCard>

        <SectionCard
          title="Channel Heat"
          subtitle="Where traffic and failures are concentrating."
          count={data?.channelHeat.length ?? 0}
        >
          <ChannelHeatList channels={data?.channelHeat ?? []} />
        </SectionCard>
      </section>
    </div>
  );
}
