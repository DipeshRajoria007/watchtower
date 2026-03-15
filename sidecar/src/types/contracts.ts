export type AgentBackendId = 'codex' | 'claude-code' | 'cursor';
export type WorkflowIntent = 'PR_REVIEW' | 'OWNER_AUTOPILOT' | 'DEV_ASSIST' | 'UNKNOWN';
export type WorkflowStatus = 'SUCCESS' | 'FAILED' | 'PAUSED' | 'SKIPPED';
export type JobLogLevel = 'INFO' | 'WARN' | 'ERROR';
export type PersonalityMode = 'normal';
export type EventIngestSource = 'socket' | 'catchup' | 'launchpad';
export type LaunchpadTarget = 'miniog';
export type LaunchpadRequestStatus =
  | 'PENDING'
  | 'CLAIMED'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'PAUSED'
  | 'SKIPPED';

export interface AppConfig {
  platformPolicy: 'macos_only';
  bundleTargets: Array<'app' | 'dmg'>;
  ownerSlackUserIds: string[];
  botUserId: string;
  slackBotToken: string;
  slackAppToken: string;
  bugsAndUpdatesChannelId: string;
  allowedChannelsForBugFix: string[];
  repoPaths: {
    newtonWeb: string;
    newtonApi: string;
  };
  workflowTimeouts: {
    prReviewMs: number;
    bugFixMs: number;
  };
  unknownTaskPolicy: 'desktop_only';
  uncertainRepoPolicy: 'desktop_only';
  unmappedPrRepoPolicy: 'desktop_only';
  maxConcurrentJobs: number;
  repoClassifierThreshold: number;
  allowedPrOrg: string;
  multiAgentEnabled: boolean;
  agentBackend: AgentBackendId;
}

export interface SlackEventEnvelope {
  eventId: string;
  channelId: string;
  channelType?: string;
  responseUrl?: string;
  threadTs: string;
  eventTs: string;
  userId: string;
  text: string;
  messageSubtype?: string;
  ingestSource?: EventIngestSource;
  launchpadRequestId?: string;
  rawEvent: Record<string, unknown>;
}

export interface LaunchpadRequestRecord {
  id: string;
  target: LaunchpadTarget;
  prompt: string;
  ownerUserId: string;
  status: LaunchpadRequestStatus;
  jobId?: string;
  slackChannelId?: string;
  anchorTs?: string;
  resultJson?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SlackReactionEvent {
  eventId: string;
  channelId: string;
  threadTs: string;
  eventTs: string;
  userId: string;
  reaction: string;
  itemUserId?: string;
  rawEvent: Record<string, unknown>;
}

export interface PrContext {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

export interface NormalizedTask {
  event: SlackEventEnvelope;
  mentionDetected: boolean;
  mentionType: 'bot' | 'owner' | 'none';
  isOwnerAuthor: boolean;
  intent: WorkflowIntent;
  prContext?: PrContext;
}

export interface RepoClassificationResult {
  selectedRepo: 'newton-web' | 'newton-api' | null;
  confidence: number;
  scoreWeb: number;
  scoreApi: number;
  signals: string[];
  uncertain: boolean;
}

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface CodexRunRequest {
  cwd: string;
  prompt: string;
  timeoutMs: number;
  outputSchemaPath?: string;
  githubToken?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  imagePaths?: string[];
  onLog?: WorkflowStepLogger;
}

export interface CodexRunResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  lastMessage: string;
  parsedJson?: Record<string, unknown>;
}

export interface WorkflowResult {
  status: WorkflowStatus;
  workflow: WorkflowIntent;
  message: string;
  notifyDesktop: boolean;
  slackPosted: boolean;
  result?: Record<string, unknown>;
}

export interface JobRecord {
  id: string;
  eventId: string;
  dedupeKey: string;
  workflow: WorkflowIntent;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'PAUSED' | 'SKIPPED';
  channelId: string;
  threadTs: string;
  attempts: number;
  payloadJson?: string;
  resultJson?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStepLog {
  level?: JobLogLevel;
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

export type WorkflowStepLogger = (step: WorkflowStepLog) => void;

export interface JobLogRecord {
  id: number;
  jobId: string;
  level: JobLogLevel;
  stage: string;
  message: string;
  dataJson?: string;
  createdAt: string;
}
