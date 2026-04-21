import type Database from 'better-sqlite3';

export interface InvestigationFindings {
  threadTs: string;
  channelId: string;
  jobId: string;
  repoName?: string;
  repoPath?: string;
  summary?: string;
  /** Full JSON body of the investigator output (root cause, evidence, recommended fix, etc.) */
  findingsJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface InvestigationStore {
  save(record: Omit<InvestigationFindings, 'createdAt' | 'updatedAt'>): void;
  getForThread(threadTs: string): InvestigationFindings | undefined;
  clear(threadTs: string): void;
}

export function createInvestigationStore(db: Database.Database): InvestigationStore {
  const upsert = db.prepare(`
    INSERT INTO investigation_findings (
      thread_ts, channel_id, job_id, repo_name, repo_path, summary, findings_json, created_at, updated_at
    )
    VALUES (@threadTs, @channelId, @jobId, @repoName, @repoPath, @summary, @findingsJson, @now, @now)
    ON CONFLICT(thread_ts) DO UPDATE SET
      channel_id = excluded.channel_id,
      job_id = excluded.job_id,
      repo_name = excluded.repo_name,
      repo_path = excluded.repo_path,
      summary = excluded.summary,
      findings_json = excluded.findings_json,
      updated_at = excluded.updated_at
  `);

  const selectOne = db.prepare(`
    SELECT thread_ts AS threadTs, channel_id AS channelId, job_id AS jobId,
           repo_name AS repoName, repo_path AS repoPath, summary,
           findings_json AS findingsJson, created_at AS createdAt, updated_at AS updatedAt
    FROM investigation_findings WHERE thread_ts = ?
  `);

  const deleteOne = db.prepare(`DELETE FROM investigation_findings WHERE thread_ts = ?`);

  return {
    save(record) {
      const now = new Date().toISOString();
      upsert.run({
        threadTs: record.threadTs,
        channelId: record.channelId,
        jobId: record.jobId,
        repoName: record.repoName ?? null,
        repoPath: record.repoPath ?? null,
        summary: record.summary ?? null,
        findingsJson: record.findingsJson,
        now,
      });
    },

    getForThread(threadTs) {
      return selectOne.get(threadTs) as InvestigationFindings | undefined;
    },

    clear(threadTs) {
      deleteOne.run(threadTs);
    },
  };
}
