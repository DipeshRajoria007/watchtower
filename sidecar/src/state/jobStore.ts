import Database from 'better-sqlite3';
import type {
  JobLogLevel,
  JobLogRecord,
  JobRecord,
  LaunchpadRequestRecord,
  LaunchpadRequestStatus,
  PersonalityMode,
  LaunchpadTarget,
  WorkflowIntent,
} from '../types/contracts.js';

function normalizeStoredPersonalityMode(_mode: unknown): PersonalityMode {
  return 'normal';
}

export class JobStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        workflow TEXT NOT NULL,
        status TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        payload_json TEXT,
        result_json TEXT,
        error_message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_event_id ON jobs(event_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_dedupe_key ON jobs(dedupe_key);

      CREATE TABLE IF NOT EXISTS job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        level TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id);

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        channel_id TEXT,
        thread_ts TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sidecar_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS launchpad_requests (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        prompt TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        job_id TEXT,
        slack_channel_id TEXT,
        anchor_ts TEXT,
        result_json TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_launchpad_requests_status_created_at ON launchpad_requests(status, created_at);

      CREATE TABLE IF NOT EXISTS learning_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        event_id TEXT,
        channel_id TEXT,
        user_id TEXT,
        workflow TEXT,
        status TEXT,
        intent TEXT,
        correction_applied INTEGER NOT NULL DEFAULT 0,
        personality_mode TEXT,
        error_kind TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_learning_signals_created_at ON learning_signals(created_at);
      CREATE INDEX IF NOT EXISTS idx_learning_signals_channel_id ON learning_signals(channel_id);

      CREATE TABLE IF NOT EXISTS intent_corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        phrase_key TEXT NOT NULL,
        corrected_intent TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel_id, user_id, phrase_key)
      );
      CREATE INDEX IF NOT EXISTS idx_intent_corrections_channel_user ON intent_corrections(channel_id, user_id);

      CREATE TABLE IF NOT EXISTS personality_profiles (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        source TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, scope_id)
      );
      CREATE INDEX IF NOT EXISTS idx_personality_profiles_scope ON personality_profiles(scope, scope_id);

      CREATE TABLE IF NOT EXISTS mission_threads (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        goal TEXT NOT NULL,
        plan TEXT NOT NULL,
        progress TEXT NOT NULL,
        blockers TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        eta TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel_id, thread_ts)
      );
      CREATE INDEX IF NOT EXISTS idx_mission_threads_channel_thread ON mission_threads(channel_id, thread_ts);

      CREATE TABLE IF NOT EXISTS mission_swarm_runs (
        run_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        roles_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mission_swarm_runs_mission ON mission_swarm_runs(mission_id, created_at);

      CREATE TABLE IF NOT EXISTS trust_policies (
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        trust_level TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(target_type, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_trust_policies_level ON trust_policies(trust_level, updated_at);

      CREATE TABLE IF NOT EXISTS replay_requests (
        request_id TEXT PRIMARY KEY,
        source_job_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_replay_requests_source ON replay_requests(source_job_id, created_at);

      CREATE TABLE IF NOT EXISTS reaction_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        user_id TEXT NOT NULL,
        reaction TEXT NOT NULL,
        sentiment INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reaction_feedback_channel ON reaction_feedback(channel_id, created_at);

      CREATE TABLE IF NOT EXISTS skill_registry (
        skill_name TEXT PRIMARY KEY,
        skill_path TEXT NOT NULL,
        version TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_channel_preferences (
        channel_id TEXT PRIMARY KEY,
        active_skill TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ops_feed_subscriptions (
        channel_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_digest_settings (
        channel_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        digest_time TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS policy_packs (
        pack_name TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_policy_packs (
        channel_id TEXT PRIMARY KEY,
        pack_name TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS incident_modes (
        channel_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_pipeline_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        pipeline_config_json TEXT NOT NULL,
        status TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        retry_loops INTEGER NOT NULL DEFAULT 0,
        total_duration_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_pipeline_runs_job_id ON agent_pipeline_runs(job_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  hasEvent(eventId: string): boolean {
    const row = this.db
      .prepare('SELECT event_id FROM events WHERE event_id = ? LIMIT 1')
      .get(eventId) as { event_id?: string } | undefined;
    return Boolean(row?.event_id);
  }

  recordEvent(eventId: string, channelId: string, threadTs: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events(event_id, channel_id, thread_ts, created_at)
         VALUES(?, ?, ?, ?)`
      )
      .run(eventId, channelId, threadTs, new Date().toISOString());
  }

  hasJobForEventTs(channelId: string, eventTs: string): boolean {
    const row = this.db
      .prepare(
        `SELECT id
         FROM jobs
         WHERE channel_id = ?
           AND json_extract(payload_json, '$.eventTs') = ?
           AND status IN ('RUNNING', 'SUCCESS', 'PAUSED', 'SKIPPED')
         LIMIT 1`
      )
      .get(channelId, eventTs) as { id?: string } | undefined;
    return Boolean(row?.id);
  }

  listKnownChannels(limit = 200): string[] {
    const stmt = this.db.prepare(
      `SELECT channel_id
       FROM events
       WHERE channel_id IS NOT NULL AND channel_id != ''
       GROUP BY channel_id
       ORDER BY MAX(created_at) DESC
       LIMIT ?`
    ) as unknown as {
      all: (limitArg: number) => Array<{
        channel_id: string;
      }>;
    };
    const rows = stmt.all(limit);
    return rows.map(row => row.channel_id).filter(Boolean);
  }

  getState(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM sidecar_state WHERE key = ? LIMIT 1')
      .get(key) as { value?: string } | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sidecar_state(key, value, updated_at)
         VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .run(key, value, now);
  }

  createLaunchpadRequest(input: {
    id: string;
    target: LaunchpadTarget;
    prompt: string;
    ownerUserId: string;
    status?: Extract<LaunchpadRequestStatus, 'PENDING' | 'CLAIMED' | 'QUEUED' | 'RUNNING'>;
    slackChannelId?: string;
    anchorTs?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO launchpad_requests(
           id, target, prompt, owner_user_id, status, slack_channel_id, anchor_ts, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.target,
        input.prompt,
        input.ownerUserId,
        input.status ?? 'PENDING',
        input.slackChannelId ?? null,
        input.anchorTs ?? null,
        now,
        now,
      );
  }

  claimPendingLaunchpadRequests(limit = 10): LaunchpadRequestRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const now = new Date().toISOString();
    const rows = (
      this.db.prepare(
        `SELECT id, target, prompt, owner_user_id, status, job_id, slack_channel_id, anchor_ts,
                result_json, error_message, created_at, updated_at
         FROM launchpad_requests
         WHERE status = 'PENDING'
         ORDER BY created_at ASC
         LIMIT ?`
      ) as unknown as {
        all: (limitArg: number) => Array<{
          id: string;
          target: LaunchpadTarget;
          prompt: string;
          owner_user_id: string;
          status: LaunchpadRequestStatus;
          job_id?: string | null;
          slack_channel_id?: string | null;
          anchor_ts?: string | null;
          result_json?: string | null;
          error_message?: string | null;
          created_at: string;
          updated_at: string;
        }>;
      }
    ).all(safeLimit);

    const claimed: LaunchpadRequestRecord[] = [];
    const claimStmt = this.db.prepare(
      `UPDATE launchpad_requests
       SET status = 'CLAIMED',
           error_message = NULL,
           updated_at = ?
       WHERE id = ? AND status = 'PENDING'`
    );

    for (const row of rows) {
      const result = claimStmt.run(now, row.id);
      if (result.changes < 1) {
        continue;
      }
      claimed.push({
        id: row.id,
        target: row.target,
        prompt: row.prompt,
        ownerUserId: row.owner_user_id,
        status: 'CLAIMED',
        jobId: row.job_id ?? undefined,
        slackChannelId: row.slack_channel_id ?? undefined,
        anchorTs: row.anchor_ts ?? undefined,
        resultJson: row.result_json ?? undefined,
        errorMessage: row.error_message ?? undefined,
        createdAt: row.created_at,
        updatedAt: now,
      });
    }

    return claimed;
  }

  markLaunchpadRequestQueued(input: {
    id: string;
    slackChannelId: string;
    anchorTs: string;
  }): void {
    this.db
      .prepare(
        `UPDATE launchpad_requests
         SET status = 'QUEUED',
             slack_channel_id = ?,
             anchor_ts = ?,
             error_message = NULL,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.slackChannelId,
        input.anchorTs,
        new Date().toISOString(),
        input.id,
      );
  }

  markLaunchpadRequestRunning(input: { id: string; jobId: string }): void {
    this.db
      .prepare(
        `UPDATE launchpad_requests
         SET status = 'RUNNING',
             job_id = ?,
             error_message = NULL,
             updated_at = ?
         WHERE id = ?`
      )
      .run(input.jobId, new Date().toISOString(), input.id);
  }

  markLaunchpadRequestFinished(input: {
    id: string;
    status: Extract<LaunchpadRequestStatus, 'SUCCESS' | 'FAILED' | 'PAUSED' | 'SKIPPED'>;
    result?: Record<string, unknown>;
    errorMessage?: string;
  }): void {
    this.db
      .prepare(
        `UPDATE launchpad_requests
         SET status = ?,
             result_json = ?,
             error_message = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status,
        input.result ? JSON.stringify(input.result) : null,
        input.errorMessage ?? null,
        new Date().toISOString(),
        input.id,
      );
  }

  getLaunchpadRequest(id: string): LaunchpadRequestRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, target, prompt, owner_user_id, status, job_id, slack_channel_id, anchor_ts,
                result_json, error_message, created_at, updated_at
         FROM launchpad_requests
         WHERE id = ?
         LIMIT 1`
      )
      .get(id) as
      | {
          id: string;
          target: LaunchpadTarget;
          prompt: string;
          owner_user_id: string;
          status: LaunchpadRequestStatus;
          job_id?: string | null;
          slack_channel_id?: string | null;
          anchor_ts?: string | null;
          result_json?: string | null;
          error_message?: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      target: row.target,
      prompt: row.prompt,
      ownerUserId: row.owner_user_id,
      status: row.status,
      jobId: row.job_id ?? undefined,
      slackChannelId: row.slack_channel_id ?? undefined,
      anchorTs: row.anchor_ts ?? undefined,
      resultJson: row.result_json ?? undefined,
      errorMessage: row.error_message ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  latestJobForThread(channelId: string, threadTs: string): { workflow: WorkflowIntent; status: JobRecord['status']; updatedAt: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT workflow, status, updated_at
         FROM jobs
         WHERE channel_id = ?
           AND thread_ts = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(channelId, threadTs) as
      | {
          workflow?: WorkflowIntent;
          status?: JobRecord['status'];
          updated_at?: string;
        }
      | undefined;

    if (!row?.workflow || !row?.status || !row?.updated_at) {
      return undefined;
    }

    return {
      workflow: row.workflow,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  hasDedupeKey(dedupeKey: string): boolean {
    const row = this.db
      .prepare('SELECT id FROM jobs WHERE dedupe_key = ? AND status IN (\'RUNNING\', \'SUCCESS\', \'PAUSED\', \'SKIPPED\') LIMIT 1')
      .get(dedupeKey) as { id?: string } | undefined;
    return Boolean(row?.id);
  }

  createJob(input: {
    id: string;
    eventId: string;
    dedupeKey: string;
    workflow: WorkflowIntent;
    channelId: string;
    threadTs: string;
    payload: Record<string, unknown>;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs(
           id, event_id, dedupe_key, workflow, status, channel_id, thread_ts,
           payload_json, attempts, created_at, updated_at
         ) VALUES(?, ?, ?, ?, 'RUNNING', ?, ?, ?, 0, ?, ?)`
      )
      .run(
        input.id,
        input.eventId,
        input.dedupeKey,
        input.workflow,
        input.channelId,
        input.threadTs,
        JSON.stringify(input.payload),
        now,
        now,
      );
  }

  bumpAttempt(jobId: string): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET attempts = attempts + 1, updated_at = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), jobId);
  }

  markJob(jobId: string, status: JobRecord['status'], options?: { errorMessage?: string; result?: Record<string, unknown> }): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = ?, error_message = ?, result_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        status,
        options?.errorMessage ?? null,
        options?.result ? JSON.stringify(options.result) : null,
        new Date().toISOString(),
        jobId,
      );
  }

  appendJobLog(input: {
    jobId: string;
    stage: string;
    message: string;
    level?: JobLogLevel;
    data?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO job_logs(job_id, level, stage, message, data_json, created_at)
         VALUES(?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.jobId,
        input.level ?? 'INFO',
        input.stage,
        input.message,
        input.data ? JSON.stringify(input.data) : null,
        new Date().toISOString(),
      );
  }

  listJobLogs(jobId: string, limit = 500): JobLogRecord[] {
    const stmt = this.db.prepare(
      `SELECT id, job_id, level, stage, message, data_json, created_at
       FROM job_logs
       WHERE job_id = ?
       ORDER BY id ASC
       LIMIT ?`
    ) as unknown as {
      all: (jobIdArg: string, limitArg: number) => Array<{
        id: number;
        job_id: string;
        level: JobLogLevel;
        stage: string;
        message: string;
        data_json?: string | null;
        created_at: string;
      }>;
    };

    const rows = stmt.all(jobId, limit);

    return rows.map(row => ({
      id: row.id,
      jobId: row.job_id,
      level: row.level,
      stage: row.stage,
      message: row.message,
      dataJson: row.data_json ?? undefined,
      createdAt: row.created_at,
    }));
  }

  saveIntentCorrection(input: {
    channelId: string;
    userId: string;
    phraseKey: string;
    correctedIntent: WorkflowIntent;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO intent_corrections(
           channel_id, user_id, phrase_key, corrected_intent, hits, created_at, updated_at
         ) VALUES(?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(channel_id, user_id, phrase_key) DO UPDATE SET
           corrected_intent = excluded.corrected_intent,
           hits = intent_corrections.hits + 1,
           updated_at = excluded.updated_at`
      )
      .run(input.channelId, input.userId, input.phraseKey, input.correctedIntent, now, now);
  }

  findIntentCorrection(input: {
    channelId: string;
    userId: string;
    phraseKey: string;
  }): WorkflowIntent | undefined {
    const exact = this.db
      .prepare(
        `SELECT corrected_intent
         FROM intent_corrections
         WHERE channel_id = ?
           AND user_id = ?
           AND phrase_key = ?
         LIMIT 1`
      )
      .get(input.channelId, input.userId, input.phraseKey) as { corrected_intent?: WorkflowIntent } | undefined;
    if (exact?.corrected_intent) {
      return exact.corrected_intent;
    }

    const stem = input.phraseKey.slice(0, 24);
    if (!stem) {
      return undefined;
    }

    const fuzzy = this.db
      .prepare(
        `SELECT corrected_intent
         FROM intent_corrections
         WHERE channel_id = ?
           AND user_id = ?
           AND phrase_key LIKE ?
         ORDER BY hits DESC, updated_at DESC
         LIMIT 1`
      )
      .get(input.channelId, input.userId, `${stem}%`) as { corrected_intent?: WorkflowIntent } | undefined;

    return fuzzy?.corrected_intent;
  }

  setPersonalityProfile(input: {
    scope: 'channel' | 'user';
    scopeId: string;
    mode: PersonalityMode;
    source: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO personality_profiles(scope, scope_id, mode, source, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(scope, scope_id) DO UPDATE SET
           mode = excluded.mode,
           source = excluded.source,
           updated_at = excluded.updated_at`
      )
      .run(input.scope, input.scopeId, input.mode, input.source, now);
  }

  getPersonalityMode(input: {
    channelId: string;
    userId: string;
  }): PersonalityMode {
    const userRow = this.db
      .prepare(
        `SELECT mode
         FROM personality_profiles
         WHERE scope = 'user' AND scope_id = ?
         LIMIT 1`
      )
      .get(input.userId) as { mode?: PersonalityMode } | undefined;
    if (userRow?.mode) {
      return normalizeStoredPersonalityMode(userRow.mode);
    }

    const channelRow = this.db
      .prepare(
        `SELECT mode
         FROM personality_profiles
         WHERE scope = 'channel' AND scope_id = ?
         LIMIT 1`
      )
      .get(input.channelId) as { mode?: PersonalityMode } | undefined;
    if (channelRow?.mode) {
      return normalizeStoredPersonalityMode(channelRow.mode);
    }

    return 'normal';
  }

  getPersonalityProfile(input: {
    scope: 'channel' | 'user';
    scopeId: string;
  }): PersonalityMode | undefined {
    const row = this.db
      .prepare(
        `SELECT mode
         FROM personality_profiles
         WHERE scope = ? AND scope_id = ?
         LIMIT 1`
      )
      .get(input.scope, input.scopeId) as { mode?: PersonalityMode } | undefined;
    return row?.mode ? normalizeStoredPersonalityMode(row.mode) : undefined;
  }

  upsertMissionStart(input: {
    channelId: string;
    threadTs: string;
    goal: string;
    ownerUserId: string;
  }): {
    id: string;
    status: string;
  } {
    const now = new Date().toISOString();
    const id = `mission:${input.channelId}:${input.threadTs}`;
    this.db
      .prepare(
        `INSERT INTO mission_threads(
           id, channel_id, thread_ts, goal, plan, progress, blockers, owner_user_id, eta, status, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, thread_ts) DO UPDATE SET
           goal = excluded.goal,
           owner_user_id = excluded.owner_user_id,
           status = excluded.status,
           updated_at = excluded.updated_at`
      )
      .run(
        id,
        input.channelId,
        input.threadTs,
        input.goal,
        'Plan pending',
        'Not started',
        'None',
        input.ownerUserId,
        'TBD',
        'ACTIVE',
        now,
        now
      );

    return {
      id,
      status: 'ACTIVE',
    };
  }

  getMissionThread(input: {
    channelId: string;
    threadTs: string;
  }): {
    id: string;
    goal: string;
    plan: string;
    progress: string;
    blockers: string;
    ownerUserId: string;
    eta: string;
    status: string;
    updatedAt: string;
  } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, goal, plan, progress, blockers, owner_user_id, eta, status, updated_at
         FROM mission_threads
         WHERE channel_id = ? AND thread_ts = ?
         LIMIT 1`
      )
      .get(input.channelId, input.threadTs) as
      | {
          id?: string;
          goal?: string;
          plan?: string;
          progress?: string;
          blockers?: string;
          owner_user_id?: string;
          eta?: string;
          status?: string;
          updated_at?: string;
        }
      | undefined;

    if (!row?.id || !row.goal || !row.plan || !row.progress || !row.blockers || !row.owner_user_id || !row.eta || !row.status || !row.updated_at) {
      return undefined;
    }

    return {
      id: row.id,
      goal: row.goal,
      plan: row.plan,
      progress: row.progress,
      blockers: row.blockers,
      ownerUserId: row.owner_user_id,
      eta: row.eta,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  updateMissionThread(input: {
    channelId: string;
    threadTs: string;
    plan?: string;
    progress?: string;
    blockers?: string;
    eta?: string;
    status?: string;
  }): boolean {
    const mission = this.getMissionThread({
      channelId: input.channelId,
      threadTs: input.threadTs,
    });
    if (!mission) {
      return false;
    }

    this.db
      .prepare(
        `UPDATE mission_threads
         SET plan = ?, progress = ?, blockers = ?, eta = ?, status = ?, updated_at = ?
         WHERE channel_id = ? AND thread_ts = ?`
      )
      .run(
        input.plan ?? mission.plan,
        input.progress ?? mission.progress,
        input.blockers ?? mission.blockers,
        input.eta ?? mission.eta,
        input.status ?? mission.status,
        new Date().toISOString(),
        input.channelId,
        input.threadTs
      );

    return true;
  }

  startMissionSwarmRun(input: {
    channelId: string;
    threadTs: string;
    requestedBy: string;
  }): {
    runId: string;
    missionId: string;
    roles: string[];
  } | undefined {
    const mission = this.getMissionThread({
      channelId: input.channelId,
      threadTs: input.threadTs,
    });
    if (!mission) {
      return undefined;
    }

    const runId = `swarm:${Date.now()}:${Math.floor(Math.random() * 100000)}`;
    const roles = ['planner', 'coder', 'reviewer', 'shipper'];
    const rolesJson = JSON.stringify(
      roles.map(role => ({
        role,
        status: 'queued',
      }))
    );

    this.db
      .prepare(
        `INSERT INTO mission_swarm_runs(
           run_id, mission_id, channel_id, thread_ts, requested_by, roles_json, status, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        mission.id,
        input.channelId,
        input.threadTs,
        input.requestedBy,
        rolesJson,
        'STARTED',
        new Date().toISOString()
      );

    this.updateMissionThread({
      channelId: input.channelId,
      threadTs: input.threadTs,
      plan: 'Swarm mode: planner -> coder -> reviewer -> shipper',
      progress: 'Swarm execution started',
      status: 'RUNNING',
    });

    return {
      runId,
      missionId: mission.id,
      roles,
    };
  }

  setTrustPolicy(input: {
    targetType: 'channel' | 'user';
    targetId: string;
    trustLevel: 'observe' | 'suggest' | 'execute' | 'merge';
    updatedBy: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO trust_policies(target_type, target_id, trust_level, updated_by, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(target_type, target_id) DO UPDATE SET
           trust_level = excluded.trust_level,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      )
      .run(
        input.targetType,
        input.targetId,
        input.trustLevel,
        input.updatedBy,
        new Date().toISOString()
      );
  }

  getTrustPolicy(input: {
    targetType: 'channel' | 'user';
    targetId: string;
  }): {
    trustLevel: 'observe' | 'suggest' | 'execute' | 'merge';
    updatedBy: string;
    updatedAt: string;
  } | undefined {
    const row = this.db
      .prepare(
        `SELECT trust_level, updated_by, updated_at
         FROM trust_policies
         WHERE target_type = ? AND target_id = ?
         LIMIT 1`
      )
      .get(input.targetType, input.targetId) as
      | {
          trust_level?: 'observe' | 'suggest' | 'execute' | 'merge';
          updated_by?: string;
          updated_at?: string;
        }
      | undefined;

    if (!row?.trust_level || !row.updated_by || !row.updated_at) {
      return undefined;
    }

    return {
      trustLevel: row.trust_level,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  }

  createReplayRequest(input: {
    sourceJobId: string;
    mode: 'replay' | 'fork';
    requestedBy: string;
    channelId: string;
    threadTs: string;
  }): {
    requestId: string;
    status: string;
  } {
    const requestId = `${input.mode}:${Date.now()}:${Math.floor(Math.random() * 100000)}`;
    this.db
      .prepare(
        `INSERT INTO replay_requests(
           request_id, source_job_id, mode, requested_by, channel_id, thread_ts, status, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        requestId,
        input.sourceJobId,
        input.mode,
        input.requestedBy,
        input.channelId,
        input.threadTs,
        'QUEUED',
        new Date().toISOString()
      );

    return {
      requestId,
      status: 'QUEUED',
    };
  }

  recordReactionFeedback(input: {
    eventId: string;
    channelId: string;
    threadTs: string;
    userId: string;
    reaction: string;
    sentiment: -1 | 0 | 1;
  }): void {
    this.db
      .prepare(
        `INSERT INTO reaction_feedback(
           event_id, channel_id, thread_ts, user_id, reaction, sentiment, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.eventId,
        input.channelId,
        input.threadTs,
        input.userId,
        input.reaction,
        input.sentiment,
        new Date().toISOString()
      );
  }

  getReactionFeedbackSnapshot(channelId: string): {
    positive: number;
    negative: number;
    neutral: number;
  } {
    const rows = (
      this.db.prepare(
        `SELECT sentiment, COUNT(*) as count
         FROM reaction_feedback
         WHERE channel_id = ?
         GROUP BY sentiment`
      ) as unknown as {
        all: (channelIdArg: string) => Array<{ sentiment: number; count: number }>;
      }
    ).all(channelId);

    let positive = 0;
    let negative = 0;
    let neutral = 0;
    for (const row of rows) {
      if (row.sentiment > 0) {
        positive = Number(row.count);
      } else if (row.sentiment < 0) {
        negative = Number(row.count);
      } else {
        neutral = Number(row.count);
      }
    }

    return { positive, negative, neutral };
  }

  registerSkill(input: {
    name: string;
    path: string;
    version: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO skill_registry(skill_name, skill_path, version, installed_at, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(skill_name) DO UPDATE SET
           skill_path = excluded.skill_path,
           version = excluded.version,
           updated_at = excluded.updated_at`
      )
      .run(input.name, input.path, input.version, now, now);
  }

  getSkill(name: string): {
    name: string;
    path: string;
    version: string;
  } | undefined {
    const row = this.db
      .prepare(
        `SELECT skill_name, skill_path, version
         FROM skill_registry
         WHERE skill_name = ?
         LIMIT 1`
      )
      .get(name) as { skill_name?: string; skill_path?: string; version?: string } | undefined;

    if (!row?.skill_name || !row.skill_path || !row.version) {
      return undefined;
    }

    return {
      name: row.skill_name,
      path: row.skill_path,
      version: row.version,
    };
  }

  setChannelSkill(input: {
    channelId: string;
    skillName: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO skill_channel_preferences(channel_id, active_skill, updated_at)
         VALUES(?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           active_skill = excluded.active_skill,
           updated_at = excluded.updated_at`
      )
      .run(input.channelId, input.skillName, new Date().toISOString());
  }

  getChannelSkill(channelId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT active_skill
         FROM skill_channel_preferences
         WHERE channel_id = ?
         LIMIT 1`
      )
      .get(channelId) as { active_skill?: string } | undefined;
    return row?.active_skill;
  }

  setOpsFeedSubscription(input: {
    channelId: string;
    enabled: boolean;
    updatedBy: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ops_feed_subscriptions(channel_id, enabled, updated_by, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           enabled = excluded.enabled,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      )
      .run(
        input.channelId,
        input.enabled ? 1 : 0,
        input.updatedBy,
        new Date().toISOString()
      );
  }

  isOpsFeedEnabled(channelId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT enabled
         FROM ops_feed_subscriptions
         WHERE channel_id = ?
         LIMIT 1`
      )
      .get(channelId) as { enabled?: number } | undefined;
    return Boolean(row?.enabled);
  }

  listOpsFeedChannels(): string[] {
    const rows = (
      this.db.prepare(
        `SELECT channel_id
         FROM ops_feed_subscriptions
         WHERE enabled = 1`
      ) as unknown as {
        all: () => Array<{ channel_id: string }>;
      }
    ).all();
    return rows.map(row => row.channel_id);
  }

  setDailyDigestSchedule(input: {
    channelId: string;
    enabled: boolean;
    digestTime?: string;
    updatedBy: string;
  }): void {
    const existing = this.db
      .prepare(
        `SELECT digest_time
         FROM daily_digest_settings
         WHERE channel_id = ?
         LIMIT 1`
      )
      .get(input.channelId) as { digest_time?: string } | undefined;
    const digestTime = (input.digestTime ?? existing?.digest_time ?? '09:30').trim();

    this.db
      .prepare(
        `INSERT INTO daily_digest_settings(channel_id, enabled, digest_time, updated_by, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           enabled = excluded.enabled,
           digest_time = excluded.digest_time,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      )
      .run(
        input.channelId,
        input.enabled ? 1 : 0,
        digestTime,
        input.updatedBy,
        new Date().toISOString()
      );
  }

  listDailyDigestSchedules(): Array<{
    channelId: string;
    digestTime: string;
  }> {
    const rows = (
      this.db.prepare(
        `SELECT channel_id, digest_time
         FROM daily_digest_settings
         WHERE enabled = 1`
      ) as unknown as {
        all: () => Array<{ channel_id: string; digest_time: string }>;
      }
    ).all();
    return rows.map(row => ({
      channelId: row.channel_id,
      digestTime: row.digest_time,
    }));
  }

  wasDigestSentToday(channelId: string, dateKey: string): boolean {
    return this.getState(`digest:last_sent:${channelId}`) === dateKey;
  }

  markDigestSentToday(channelId: string, dateKey: string): void {
    this.setState(`digest:last_sent:${channelId}`, dateKey);
  }

  importPolicyPack(input: {
    channelId: string;
    packName: 'frontend' | 'backend' | 'release';
    updatedBy: string;
  }): {
    packName: 'frontend' | 'backend' | 'release';
    description: string;
    rules: string[];
  } {
    const defaults: Record<'frontend' | 'backend' | 'release', { description: string; rules: string[] }> = {
      frontend: {
        description: 'Frontend safety rails for UI quality and release confidence.',
        rules: [
          'Require visual-impact summary and affected routes/components.',
          'No merge if accessibility regressions are found.',
          'Prefer squash merge after at least one passing CI run.',
        ],
      },
      backend: {
        description: 'Backend reliability and API contract guardrails.',
        rules: [
          'Require backward-compatible API change notes.',
          'Block merge on failing integration tests or migration mismatch.',
          'Require rollback note for risky DB/cache changes.',
        ],
      },
      release: {
        description: 'Release governance pack for risky deploy windows.',
        rules: [
          'No merge without release checklist sign-off.',
          'Require staged rollout plan and monitoring guard metrics.',
          'Escalate hotfixes touching auth/payments/checkout.',
        ],
      },
    };

    const selected = defaults[input.packName];
    const now = new Date().toISOString();
    const rulesJson = JSON.stringify(selected.rules);

    this.db
      .prepare(
        `INSERT INTO policy_packs(pack_name, description, rules_json, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(pack_name) DO UPDATE SET
           description = excluded.description,
           rules_json = excluded.rules_json,
           updated_at = excluded.updated_at`
      )
      .run(input.packName, selected.description, rulesJson, now);

    this.db
      .prepare(
        `INSERT INTO channel_policy_packs(channel_id, pack_name, updated_by, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           pack_name = excluded.pack_name,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      )
      .run(input.channelId, input.packName, input.updatedBy, now);

    return {
      packName: input.packName,
      description: selected.description,
      rules: selected.rules,
    };
  }

  getChannelPolicyPack(channelId: string): {
    packName: 'frontend' | 'backend' | 'release';
    description: string;
    rules: string[];
    updatedAt: string;
  } | undefined {
    const row = this.db
      .prepare(
        `SELECT c.pack_name, c.updated_at, p.description, p.rules_json
         FROM channel_policy_packs c
         JOIN policy_packs p ON p.pack_name = c.pack_name
         WHERE c.channel_id = ?
         LIMIT 1`
      )
      .get(channelId) as
      | {
          pack_name?: 'frontend' | 'backend' | 'release';
          updated_at?: string;
          description?: string;
          rules_json?: string;
        }
      | undefined;

    if (!row?.pack_name || !row.updated_at || !row.description || !row.rules_json) {
      return undefined;
    }

    let rules: string[] = [];
    try {
      const parsed = JSON.parse(row.rules_json) as unknown;
      if (Array.isArray(parsed)) {
        rules = parsed.map(item => String(item)).filter(Boolean);
      }
    } catch {
      rules = [];
    }

    return {
      packName: row.pack_name,
      description: row.description,
      rules,
      updatedAt: row.updated_at,
    };
  }

  setIncidentMode(input: {
    channelId: string;
    enabled: boolean;
    updatedBy: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO incident_modes(channel_id, enabled, updated_by, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           enabled = excluded.enabled,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      )
      .run(input.channelId, input.enabled ? 1 : 0, input.updatedBy, new Date().toISOString());
  }

  listIncidentChannels(): string[] {
    const rows = (
      this.db.prepare(
        `SELECT channel_id
         FROM incident_modes
         WHERE enabled = 1`
      ) as unknown as {
        all: () => Array<{ channel_id: string }>;
      }
    ).all();
    return rows.map(row => row.channel_id);
  }

  getIncidentSnapshot(channelId: string): {
    running: number;
    failed60m: number;
    paused60m: number;
    topWorkflow: string;
  } {
    const running = Number(
      (this.db
        .prepare(
          `SELECT COUNT(*) as count
           FROM jobs
           WHERE channel_id = ? AND status = 'RUNNING'`
        )
        .get(channelId) as { count?: number } | undefined)?.count ?? 0
    );

    const failed60m = Number(
      (this.db
        .prepare(
          `SELECT COUNT(*) as count
           FROM jobs
           WHERE channel_id = ?
             AND status = 'FAILED'
             AND julianday(created_at) >= julianday('now', '-60 minute')`
        )
        .get(channelId) as { count?: number } | undefined)?.count ?? 0
    );

    const paused60m = Number(
      (this.db
        .prepare(
          `SELECT COUNT(*) as count
           FROM jobs
           WHERE channel_id = ?
             AND status = 'PAUSED'
             AND julianday(created_at) >= julianday('now', '-60 minute')`
        )
        .get(channelId) as { count?: number } | undefined)?.count ?? 0
    );

    const topWorkflow =
      (
        this.db
          .prepare(
            `SELECT workflow
             FROM jobs
             WHERE channel_id = ?
               AND status IN ('FAILED', 'PAUSED')
               AND julianday(created_at) >= julianday('now', '-60 minute')
             GROUP BY workflow
             ORDER BY COUNT(*) DESC, workflow ASC
             LIMIT 1`
          )
          .get(channelId) as { workflow?: string } | undefined
      )?.workflow ?? 'none';

    return {
      running,
      failed60m,
      paused60m,
      topWorkflow,
    };
  }

  recordLearningSignal(input: {
    jobId: string;
    eventId: string;
    channelId: string;
    userId: string;
    workflow: WorkflowIntent;
    intent: WorkflowIntent;
    status: JobRecord['status'];
    correctionApplied: boolean;
    errorKind?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO learning_signals(
           job_id, event_id, channel_id, user_id, workflow, status, intent,
           correction_applied, personality_mode, error_kind, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.jobId,
        input.eventId,
        input.channelId,
        input.userId,
        input.workflow,
        input.status,
        input.intent,
        input.correctionApplied ? 1 : 0,
        'normal',
        input.errorKind ?? null,
        new Date().toISOString()
      );
  }

  findLatestReviewedPrHeadSha(input: {
    channelId: string;
    threadTs: string;
    prUrl: string;
  }): { jobId: string; prHeadSha: string; updatedAt: string } | undefined {
    const stmt = this.db.prepare(
      `SELECT id, result_json, updated_at
       FROM jobs
       WHERE workflow = 'PR_REVIEW'
         AND status = 'SUCCESS'
         AND channel_id = ?
         AND thread_ts = ?
       ORDER BY updated_at DESC
       LIMIT 50`
    ) as unknown as {
      all: (channelIdArg: string, threadTsArg: string) => Array<{
        id: string;
        result_json?: string | null;
        updated_at: string;
      }>;
    };

    const rows = stmt.all(input.channelId, input.threadTs);
    for (const row of rows) {
      if (!row.result_json) {
        continue;
      }

      try {
        const parsed = JSON.parse(row.result_json) as Record<string, unknown>;
        const prUrl = typeof parsed.prUrl === 'string' ? parsed.prUrl : '';
        const prHeadSha = typeof parsed.prHeadSha === 'string' ? parsed.prHeadSha : '';
        if (prUrl === input.prUrl && prHeadSha) {
          return {
            jobId: row.id,
            prHeadSha,
            updatedAt: row.updated_at,
          };
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }

  getDevStatusSnapshot(): {
    activeJobs: number;
    runs24h: number;
    failures24h: number;
    successRate24h: number;
  } {
    const activeJobs = Number(
      (this.db
        .prepare(`SELECT COUNT(*) as count FROM jobs WHERE status = 'RUNNING'`)
        .get() as { count?: number } | undefined)?.count ?? 0
    );

    const runs24h = Number(
      (this.db
        .prepare(`SELECT COUNT(*) as count FROM jobs WHERE julianday(created_at) >= julianday('now', '-1 day')`)
        .get() as { count?: number } | undefined)?.count ?? 0
    );

    const failures24h = Number(
      (this.db
        .prepare(
          `SELECT COUNT(*) as count
           FROM jobs
           WHERE status = 'FAILED'
             AND julianday(created_at) >= julianday('now', '-1 day')`
        )
        .get() as { count?: number } | undefined)?.count ?? 0
    );

    const success24h = Number(
      (this.db
        .prepare(
          `SELECT COUNT(*) as count
           FROM jobs
           WHERE status = 'SUCCESS'
             AND julianday(created_at) >= julianday('now', '-1 day')`
        )
        .get() as { count?: number } | undefined)?.count ?? 0
    );

    const successRate24h = runs24h > 0 ? Math.round((success24h / runs24h) * 1000) / 10 : 100;

    return {
      activeJobs,
      runs24h,
      failures24h,
      successRate24h,
    };
  }

  listDevRuns(limit: number, status?: JobRecord['status']): Array<{
    id: string;
    workflow: WorkflowIntent;
    status: JobRecord['status'];
    updatedAt: string;
    errorMessage?: string;
  }> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const rows = status
      ? ((this.db.prepare(
          `SELECT id, workflow, status, updated_at, error_message
           FROM jobs
           WHERE status = ?
           ORDER BY updated_at DESC
           LIMIT ?`
        ) as unknown as {
          all: (
            statusArg: JobRecord['status'],
            limitArg: number
          ) => Array<{
            id: string;
            workflow: WorkflowIntent;
            status: JobRecord['status'];
            updated_at: string;
            error_message?: string | null;
          }>;
        }).all(status, safeLimit))
      : ((this.db.prepare(
          `SELECT id, workflow, status, updated_at, error_message
           FROM jobs
           ORDER BY updated_at DESC
           LIMIT ?`
        ) as unknown as {
          all: (limitArg: number) => Array<{
            id: string;
            workflow: WorkflowIntent;
            status: JobRecord['status'];
            updated_at: string;
            error_message?: string | null;
          }>;
        }).all(safeLimit));

    return rows.map(row => ({
      id: row.id,
      workflow: row.workflow,
      status: row.status,
      updatedAt: row.updated_at,
      errorMessage: row.error_message ?? undefined,
    }));
  }

  getPersonalQueue(input: {
    channelId: string;
    userId: string;
    limit: number;
  }): Array<{
    id: string;
    workflow: WorkflowIntent;
    status: JobRecord['status'];
    threadTs: string;
    summary: string;
    updatedAt: string;
  }> {
    const safeLimit = Math.min(Math.max(input.limit, 1), 20);
    const rows = (
      this.db.prepare(
        `SELECT id, workflow, status, thread_ts, payload_json, updated_at
         FROM jobs
         WHERE channel_id = ?
           AND (
             json_extract(payload_json, '$.requestUserId') = ?
             OR payload_json LIKE ?
           )
         ORDER BY
           CASE status
             WHEN 'FAILED' THEN 0
             WHEN 'PAUSED' THEN 1
             WHEN 'RUNNING' THEN 2
             ELSE 3
           END ASC,
           updated_at DESC
         LIMIT ?`
      ) as unknown as {
        all: (
          channelIdArg: string,
          userIdArg: string,
          mentionPatternArg: string,
          limitArg: number
        ) => Array<{
          id: string;
          workflow: WorkflowIntent;
          status: JobRecord['status'];
          thread_ts: string;
          payload_json?: string | null;
          updated_at: string;
        }>;
      }
    ).all(input.channelId, input.userId, `%<@${input.userId}>%`, safeLimit);

    const mapped = rows.map(row => {
      let summary = '';
      try {
        const payload = row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : {};
        summary = String(payload.text ?? '').replace(/\s+/g, ' ').trim();
      } catch {
        summary = '';
      }
      return {
        id: row.id,
        workflow: row.workflow,
        status: row.status,
        threadTs: row.thread_ts,
        summary: summary.slice(0, 140),
        updatedAt: row.updated_at,
      };
    });

    if (mapped.length > 0) {
      return mapped;
    }

    // Fallback to channel queue when user-specific queue is empty.
    return this.listDevRuns(safeLimit).map(item => ({
      id: item.id,
      workflow: item.workflow,
      status: item.status,
      threadTs: '',
      summary: item.errorMessage ?? '',
      updatedAt: item.updatedAt,
    }));
  }

  resolveJobId(prefixOrId: string): string | undefined {
    const value = prefixOrId.trim();
    if (!value) {
      return undefined;
    }

    const exact = this.db
      .prepare(`SELECT id FROM jobs WHERE id = ? LIMIT 1`)
      .get(value) as { id?: string } | undefined;
    if (exact?.id) {
      return exact.id;
    }

    const fuzzy = this.db
      .prepare(
        `SELECT id
         FROM jobs
         WHERE id LIKE ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(`${value}%`) as { id?: string } | undefined;
    return fuzzy?.id;
  }

  listJobLogsTail(jobId: string, limit = 20): JobLogRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const stmt = this.db.prepare(
      `SELECT id, job_id, level, stage, message, data_json, created_at
       FROM job_logs
       WHERE job_id = ?
       ORDER BY id DESC
       LIMIT ?`
    ) as unknown as {
      all: (jobIdArg: string, limitArg: number) => Array<{
        id: number;
        job_id: string;
        level: JobLogLevel;
        stage: string;
        message: string;
        data_json?: string | null;
        created_at: string;
      }>;
    };

    const rows = stmt.all(jobId, safeLimit).reverse();
    return rows.map(row => ({
      id: row.id,
      jobId: row.job_id,
      level: row.level,
      stage: row.stage,
      message: row.message,
      dataJson: row.data_json ?? undefined,
      createdAt: row.created_at,
    }));
  }

  getJobSummary(jobId: string): {
    id: string;
    workflow: WorkflowIntent;
    status: JobRecord['status'];
    errorMessage?: string;
  } | undefined {
    const row = this.db
      .prepare(`SELECT id, workflow, status, error_message FROM jobs WHERE id = ? LIMIT 1`)
      .get(jobId) as
      | {
          id?: string;
          workflow?: WorkflowIntent;
          status?: JobRecord['status'];
          error_message?: string | null;
        }
      | undefined;

    if (!row?.id || !row.workflow || !row.status) {
      return undefined;
    }

    return {
      id: row.id,
      workflow: row.workflow,
      status: row.status,
      errorMessage: row.error_message ?? undefined,
    };
  }

  getDevLearningSnapshot(): {
    signals24h: number;
    correctionsLearned: number;
    correctionsApplied24h: number;
    personalityProfiles: number;
    topErrorKind: string;
  } {
    const signals24h = Number(
      (this.db
        .prepare(`SELECT COUNT(*) as count FROM learning_signals WHERE julianday(created_at) >= julianday('now', '-1 day')`)
        .get() as { count?: number } | undefined)?.count ?? 0
    );

    const correctionsLearned = Number(
      (this.db
        .prepare(`SELECT COUNT(*) as count FROM intent_corrections`)
        .get() as { count?: number } | undefined)?.count ?? 0
    );

    const correctionsApplied24h = Number(
      (this.db
        .prepare(
          `SELECT COUNT(*) as count
           FROM learning_signals
           WHERE correction_applied = 1
             AND julianday(created_at) >= julianday('now', '-1 day')`
        )
        .get() as { count?: number } | undefined)?.count ?? 0
    );

    const personalityProfiles = Number(
      (this.db
        .prepare(`SELECT COUNT(*) as count FROM personality_profiles`)
        .get() as { count?: number } | undefined)?.count ?? 0
    );

    const topErrorKind =
      (
        this.db
          .prepare(
            `SELECT error_kind
             FROM learning_signals
             WHERE error_kind IS NOT NULL AND error_kind != ''
             GROUP BY error_kind
             ORDER BY COUNT(*) DESC, error_kind ASC
             LIMIT 1`
          )
          .get() as { error_kind?: string } | undefined
      )?.error_kind ?? 'none';

    return {
      signals24h,
      correctionsLearned,
      correctionsApplied24h,
      personalityProfiles,
      topErrorKind,
    };
  }

  getDevChannelHeat(limit = 5): Array<{
    channelId: string;
    runs: number;
    failures: number;
  }> {
    const safeLimit = Math.min(Math.max(limit, 1), 20);
    const stmt = this.db.prepare(
      `SELECT channel_id,
              COUNT(*) as runs,
              SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failures
       FROM jobs
       WHERE julianday(created_at) >= julianday('now', '-7 day')
       GROUP BY channel_id
       ORDER BY runs DESC, failures DESC, channel_id ASC
       LIMIT ?`
    ) as unknown as {
      all: (limitArg: number) => Array<{
        channel_id: string;
        runs: number;
        failures: number;
      }>;
    };

    return stmt.all(safeLimit).map(row => ({
      channelId: row.channel_id,
      runs: Number(row.runs),
      failures: Number(row.failures),
    }));
  }

  // --- Agent Pipeline Runs ---

  createPipelineRun(input: {
    id: string;
    jobId: string;
    pipelineConfigJson: string;
    status: string;
    stepsJson: string;
    retryLoops?: number;
    totalDurationMs?: number;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_pipeline_runs(
           id, job_id, pipeline_config_json, status, steps_json,
           retry_loops, total_duration_ms, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.jobId,
        input.pipelineConfigJson,
        input.status,
        input.stepsJson,
        input.retryLoops ?? 0,
        input.totalDurationMs ?? null,
        now,
        now,
      );
  }

  updatePipelineRun(
    id: string,
    updates: {
      status?: string;
      stepsJson?: string;
      retryLoops?: number;
      totalDurationMs?: number;
    },
  ): void {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }
    if (updates.stepsJson !== undefined) {
      sets.push('steps_json = ?');
      values.push(updates.stepsJson);
    }
    if (updates.retryLoops !== undefined) {
      sets.push('retry_loops = ?');
      values.push(updates.retryLoops);
    }
    if (updates.totalDurationMs !== undefined) {
      sets.push('total_duration_ms = ?');
      values.push(updates.totalDurationMs);
    }

    values.push(id);
    this.db.prepare(`UPDATE agent_pipeline_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getPipelineRunByJobId(jobId: string): {
    id: string;
    jobId: string;
    pipelineConfigJson: string;
    status: string;
    stepsJson: string;
    retryLoops: number;
    totalDurationMs: number | null;
    createdAt: string;
    updatedAt: string;
  } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, job_id, pipeline_config_json, status, steps_json,
                retry_loops, total_duration_ms, created_at, updated_at
         FROM agent_pipeline_runs
         WHERE job_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(jobId) as Record<string, unknown> | undefined;

    if (!row) return undefined;

    return {
      id: String(row.id),
      jobId: String(row.job_id),
      pipelineConfigJson: String(row.pipeline_config_json),
      status: String(row.status),
      stepsJson: String(row.steps_json),
      retryLoops: Number(row.retry_loops),
      totalDurationMs: row.total_duration_ms != null ? Number(row.total_duration_ms) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
