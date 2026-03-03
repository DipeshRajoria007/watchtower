import Database from 'better-sqlite3';
import type { JobLogLevel, JobLogRecord, JobRecord, WorkflowIntent } from '../types/contracts.js';

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
}
