export type WorkflowIntent = 'PR_REVIEW' | 'BUG_FIX' | 'UNKNOWN';
export type WorkflowStatus = 'SUCCESS' | 'FAILED' | 'PAUSED' | 'SKIPPED';

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
}

export interface SlackEventEnvelope {
  eventId: string;
  channelId: string;
  threadTs: string;
  eventTs: string;
  userId: string;
  text: string;
  messageSubtype?: string;
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

export interface CodexRunRequest {
  cwd: string;
  prompt: string;
  timeoutMs: number;
  outputSchemaPath?: string;
  githubToken?: string;
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
