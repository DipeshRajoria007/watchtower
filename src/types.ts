export type AppView = 'overview' | 'launchpad' | 'runs' | 'intelligence' | 'settings';

export type RunsSubView = 'active' | 'failures' | 'recent' | 'diagnostics';

export type SlackCommandTarget = 'miniog' | 'watchtower';

export type RunSummary = {
  id: string;
  workflow: string;
  status: string;
  channelId: string;
  threadTs: string;
  createdAt: string;
  updatedAt: string;
  errorMessage: string | null;
};

export type DashboardMetrics = {
  runs24h: number;
  successRate24h: number;
  failedRuns24h: number;
  avgResolutionSeconds24h: number;
  unknownTasks24h: number;
  catchupRecovered24h: number;
  successStreak: number;
  chaosIndex: number;
};

export type DashboardRecommendation = {
  id: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW' | string;
  title: string;
  detail: string;
};

export type ChannelHeat = {
  channelId: string;
  runs: number;
  failures: number;
};

export type PersonalityModeStats = {
  mode: string;
  count: number;
};

export type LearningInsights = {
  signals24h: number;
  correctionsLearned: number;
  correctionsApplied24h: number;
  personalityProfiles: number;
  dominantPersonalityMode: string;
  topFailureKind: string;
  topFailureCount: number;
  profilesByMode: PersonalityModeStats[];
};

export type DashboardData = {
  sidecarStatus: string;
  settingsConfigured: boolean;
  activeJobs: RunSummary[];
  recentRuns: RunSummary[];
  failures: RunSummary[];
  metrics: DashboardMetrics;
  learning: LearningInsights;
  recommendations: DashboardRecommendation[];
  channelHeat: ChannelHeat[];
};

export type JobLogEntry = {
  id: number;
  jobId: string;
  level: 'INFO' | 'WARN' | 'ERROR' | string;
  stage: string;
  message: string;
  dataJson: string | null;
  createdAt: string;
};

export type AppSettings = {
  slackBotToken: string;
  slackAppToken: string;
  ownerSlackUserIds: string;
  botUserId: string;
  bugsAndUpdatesChannelId: string;
  newtonWebPath: string;
  newtonApiPath: string;
  maxConcurrentJobs: number;
  prReviewTimeoutMs: number;
  bugFixTimeoutMs: number;
  repoClassifierThreshold: number;
};

export type SaveSettingsResponse = {
  configured: boolean;
};
