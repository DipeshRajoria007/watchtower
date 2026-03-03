import Database from 'better-sqlite3';
import type {
  JobLogLevel,
  JobLogRecord,
  JobRecord,
  PersonalityMode,
  WorkflowIntent,
} from '../types/contracts.js';

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
      return userRow.mode;
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
      return channelRow.mode;
    }

    return 'dark_humor';
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
    personalityMode: PersonalityMode;
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
        input.personalityMode,
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
}
