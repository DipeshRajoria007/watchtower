export type AgentBackendId = 'codex' | 'claude-code';
export type AccessMode = 'audit' | 'enforce';
export type AccessGroupKey = 'viewer' | 'reviewer' | 'builder' | 'admin' | 'owner';
export type AccessLevel = AccessGroupKey;
export type WorkflowIntent =
  | 'PR_REVIEW'
  | 'OWNER_AUTOPILOT'
  | 'IMPLEMENTATION'
  | 'INVESTIGATION'
  | 'INFORMATIONAL'
  | 'CONVERSATIONAL'
  | 'NONE'
  | 'DEV_ASSIST'
  | 'DEPLOY'
  | 'MINIOG_DOSSIER'
  | 'UNKNOWN';
export type WorkflowStatus = 'SUCCESS' | 'FAILED' | 'PAUSED' | 'SKIPPED' | 'CANCELLED';
export type JobLogLevel = 'INFO' | 'WARN' | 'ERROR';
export type PersonalityMode = 'normal' | 'terse' | 'technical' | 'casual';

export type DossierRole = 'pm' | 'dev' | 'designer' | 'ops' | 'analyst';
export type DossierForgetField = 'role' | 'tone' | 'notes' | 'project_affinity' | 'metrics' | 'all';

export type MiniogSubcommand =
  | { kind: 'whoami' }
  | { kind: 'set-role'; role: DossierRole }
  | { kind: 'forget'; field: DossierForgetField; confirmed: boolean }
  | { kind: 'remember'; text: string }
  | { kind: 'memories' }
  | { kind: 'forget-memory'; id: number };
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

export interface AccessGroupSettings {
  slackUserGroupHandle: string;
  manualUserIds: string;
  allowedChannelIds: string;
  allowIm: boolean;
  allowMpim: boolean;
}

export interface AccessControlSettings {
  mode: AccessMode;
  groups: Record<AccessGroupKey, AccessGroupSettings>;
}

export interface ResolvedAccessGroup extends AccessGroupSettings {
  key: AccessGroupKey;
  resolvedChannelIds: string[];
  resolvedUserIds: string[];
}

export interface AccessControlConfig {
  mode: AccessMode;
  groups: Record<AccessGroupKey, ResolvedAccessGroup>;
}

export interface AppConfig {
  platformPolicy: 'macos_only';
  bundleTargets: Array<'app' | 'dmg'>;
  ownerSlackUserIds: string[];
  coreDevSlackUserIds: string[];
  coreDevSlackUserGroup: string;
  botUserId: string;
  slackBotToken: string;
  slackAppToken: string;
  bugsAndUpdatesChannelId: string;
  allowedChannelsForBugFix: string[];
  repoPaths: {
    newtonWeb: string;
    newtonApi: string;
    /**
     * Optional absolute path to the watchtower repo itself. Powers the
     * self-inquiry target in the informational workflow so miniOG can answer
     * questions about its own configuration. If unset, the workflow attempts
     * to auto-detect via the sidecar's __dirname.
     */
    watchtower?: string;
  };
  /**
   * Absolute directory that miniOG's working clones must live under. Enforced
   * at config load: if `repoPaths.newtonWeb` or `repoPaths.newtonApi` is not
   * under this root, config load fails and implementation work is refused.
   * Keeps the coder agent away from the user's personal clones (which may
   * have arbitrary feature branches checked out). Optional at the type level
   * only so existing test fixtures compile; production AppConfig values
   * always set it via `mapSettingsToConfig`.
   */
  miniOgRepoRoot?: string;
  unknownTaskPolicy: 'desktop_only';
  uncertainRepoPolicy: 'desktop_only';
  unmappedPrRepoPolicy: 'desktop_only';
  maxConcurrentJobs: number;
  repoClassifierThreshold: number;
  allowedPrOrg: string;
  multiAgentEnabled: boolean;
  agentBackend: AgentBackendId;
  prReviewTimeoutMs: number;
  bugFixTimeoutMs: number;
  pmTaskTimeoutMs: number;
  accessControl?: AccessControlConfig;
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
  isCoreDevAuthor: boolean;
  intent: WorkflowIntent;
  prContext?: PrContext;
  miniogSubcommand?: MiniogSubcommand;
  /**
   * Dossier-derived tone preference, populated by the router after looking up
   * the requesting user's personality_profiles row. Defaults to 'normal' when
   * no per-user override is set; downstream prompts honor this.
   */
  toneMode?: PersonalityMode;
  /**
   * Asker's dossier role, populated by the router. Conversational prompts
   * adapt their explanation depth and code-snippet density based on this
   * (non-dev roles get plain-language, low-code answers).
   */
  dossierRole?: DossierRole;
}

export interface RepoClassificationResult {
  selectedRepo: 'newton-web' | 'newton-api' | null;
  confidence: number;
  reasoning: string;
  uncertain: boolean;
}

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CodexRunRequest {
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  outputSchemaPath?: string;
  githubToken?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  imagePaths?: string[];
  onLog?: WorkflowStepLogger;
  signal?: AbortSignal;
  /** Start a new Claude Code session with this ID. */
  sessionId?: string;
  /** Resume an existing Claude Code session (sends prompt as follow-up). */
  resumeSessionId?: string;
  /**
   * Run the backend in plan mode. Only honored by the claude-code backend
   * (adds `--permission-mode plan`). The Codex backend ignores this.
   */
  planMode?: boolean;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type CostSource = 'reported' | 'computed';

export interface CodexRunResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  cancelled?: boolean;
  stdout: string;
  stderr: string;
  lastMessage: string;
  parsedJson?: Record<string, unknown>;
  /** Wall-clock duration from process spawn to exit, in milliseconds. */
  durationMs: number;
  /** Token usage extracted from backend output, when available. */
  usage?: TokenUsage;
  /** Cost in USD: backend-reported when available, otherwise computed from price table. */
  costUsd?: number;
  /** Provenance of `costUsd` so callers can distinguish authoritative vs estimated costs. */
  costSource?: CostSource;
  /** Backend that produced this result. */
  backend: AgentBackendId;
  /** Model identifier used (request.model when set, otherwise backend default). */
  modelUsed?: string;
  /** Session ID returned by Claude Code, usable for session resumption. */
  sessionId?: string;
}

export interface AgentCallRecord {
  id?: number;
  jobId: string;
  pipelineRunId?: string;
  role?: string;
  backend: AgentBackendId;
  model?: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  costSource?: CostSource;
  ok: boolean;
  createdAt: string;
}

export interface JobCostSummary {
  jobId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  callCount: number;
  calls: AgentCallRecord[];
}

export interface CallSummarySince {
  totalCostUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  cacheHitRate: number;
}

export interface WorkflowResult {
  status: WorkflowStatus;
  workflow: WorkflowIntent;
  message: string;
  notifyDesktop: boolean;
  slackPosted: boolean;
  result?: Record<string, unknown>;
  /**
   * Set when status === 'PAUSED' to capture the workflow's wait-stage state so a
   * later @miniOG mention in the same thread can resume execution at the same
   * point. Persisted into jobs.result_json by the dispatcher and reloaded on resume.
   */
  resumeContext?: ResumeContext;
}

/**
 * Implementation workflow paused at the plan-approval gate, waiting for either
 * an admin approve/reject/feedback OR (now) a "wait" + later @-mention to resume.
 */
export interface ImplementationApprovalResume {
  workflow: 'IMPLEMENTATION' | 'OWNER_AUTOPILOT';
  stage: 'awaiting_approval';
  iteration: number;
  feedbackRounds: number;
  planMarkdown: string;
  planAffectedFiles: string[];
  planScope: string;
  plannerSessionId?: string;
  plannerOutput?: Record<string, unknown>;
  planMessageTs?: string;
  approvalPromptTs?: string;
  pipelineCwd: string;
  pauseCount: number;
}

/** Implementation workflow paused after a reject prompt asking "want to revise?". */
export interface ImplementationRevisionChoiceResume {
  workflow: 'IMPLEMENTATION' | 'OWNER_AUTOPILOT';
  stage: 'awaiting_revision_choice';
  iteration: number;
  feedbackRounds: number;
  planMarkdown: string;
  planAffectedFiles: string[];
  planScope: string;
  plannerSessionId?: string;
  plannerOutput?: Record<string, unknown>;
  planMessageTs?: string;
  askReviseTs?: string;
  pipelineCwd: string;
  pauseCount: number;
}

/** Implementation workflow paused at the repo-choice clarification gate. */
export interface ImplementationRepoChoiceResume {
  workflow: 'IMPLEMENTATION' | 'OWNER_AUTOPILOT';
  stage: 'awaiting_repo_choice';
  promptTs?: string;
  pauseCount: number;
}

export type ResumeContext =
  | ImplementationApprovalResume
  | ImplementationRevisionChoiceResume
  | ImplementationRepoChoiceResume;

export interface JobRecord {
  id: string;
  eventId: string;
  dedupeKey: string;
  workflow: WorkflowIntent;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'PAUSED' | 'SKIPPED' | 'CANCELLED';
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
