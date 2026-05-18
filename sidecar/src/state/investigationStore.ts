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
  /**
   * Slack ts of the "Want me to fix this?" prompt message posted by the
   * investigation workflow. Used by `processReactionFeedback` to detect a
   * ✅ reaction on the prompt and dispatch a synthetic resume event when the
   * user (or an admin) confirms without re-tagging the bot. Nullable so
   * older rows from before this column existed still load.
   */
  promptMessageTs?: string;
  /** Slack user ID of the original requester who triggered the investigation. */
  requesterUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InvestigationStore {
  save(record: Omit<InvestigationFindings, 'createdAt' | 'updatedAt'>): void;
  getForThread(threadTs: string): InvestigationFindings | undefined;
  /** Look up findings by the prompt-message ts — used by the reaction-resume path. */
  getByPromptMessageTs(channelId: string, promptMessageTs: string): InvestigationFindings | undefined;
  clear(threadTs: string): void;
}

export function createInvestigationStore(db: Database.Database): InvestigationStore {
  const upsert = db.prepare(`
    INSERT INTO investigation_findings (
      thread_ts, channel_id, job_id, repo_name, repo_path, summary, findings_json,
      prompt_message_ts, requester_user_id, created_at, updated_at
    )
    VALUES (
      @threadTs, @channelId, @jobId, @repoName, @repoPath, @summary, @findingsJson,
      @promptMessageTs, @requesterUserId, @now, @now
    )
    ON CONFLICT(thread_ts) DO UPDATE SET
      channel_id = excluded.channel_id,
      job_id = excluded.job_id,
      repo_name = excluded.repo_name,
      repo_path = excluded.repo_path,
      summary = excluded.summary,
      findings_json = excluded.findings_json,
      prompt_message_ts = excluded.prompt_message_ts,
      requester_user_id = excluded.requester_user_id,
      updated_at = excluded.updated_at
  `);

  const SELECT_COLS = `
    thread_ts AS threadTs, channel_id AS channelId, job_id AS jobId,
    repo_name AS repoName, repo_path AS repoPath, summary,
    findings_json AS findingsJson,
    prompt_message_ts AS promptMessageTs,
    requester_user_id AS requesterUserId,
    created_at AS createdAt, updated_at AS updatedAt
  `;

  const selectOne = db.prepare(`SELECT ${SELECT_COLS} FROM investigation_findings WHERE thread_ts = ?`);

  const selectByPromptTs = db.prepare(
    `SELECT ${SELECT_COLS} FROM investigation_findings WHERE channel_id = ? AND prompt_message_ts = ?`,
  );

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
        promptMessageTs: record.promptMessageTs ?? null,
        requesterUserId: record.requesterUserId ?? null,
        now,
      });
    },

    getForThread(threadTs) {
      return selectOne.get(threadTs) as InvestigationFindings | undefined;
    },

    getByPromptMessageTs(channelId, promptMessageTs) {
      return selectByPromptTs.get(channelId, promptMessageTs) as InvestigationFindings | undefined;
    },

    clear(threadTs) {
      deleteOne.run(threadTs);
    },
  };
}
