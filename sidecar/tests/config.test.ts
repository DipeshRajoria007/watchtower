import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { loadConfigFromDb } from '../src/config.js';

function makeDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-config-'));
  const dbPath = path.join(dir, 'watchtower.db');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      slack_bot_token TEXT NOT NULL DEFAULT '',
      slack_app_token TEXT NOT NULL DEFAULT '',
      owner_slack_user_ids TEXT NOT NULL DEFAULT '',
      bot_user_id TEXT NOT NULL DEFAULT '',
      bugs_and_updates_channel_id TEXT NOT NULL DEFAULT 'C01H25RNLJH',
      newton_web_path TEXT NOT NULL DEFAULT '',
      newton_api_path TEXT NOT NULL DEFAULT '',
      max_concurrent_jobs INTEGER NOT NULL DEFAULT 2,
      pr_review_timeout_ms INTEGER NOT NULL DEFAULT 720000,
      bug_fix_timeout_ms INTEGER NOT NULL DEFAULT 2700000,
      repo_classifier_threshold REAL NOT NULL DEFAULT 0.75,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO app_settings(id) VALUES (1);
  `);

  db.close();
  return dbPath;
}

describe('loadConfigFromDb', () => {
  it('loads config from persisted settings', () => {
    const dbPath = makeDb();
    const db = new Database(dbPath);

    db.prepare(`
      UPDATE app_settings
      SET slack_bot_token = ?,
          slack_app_token = ?,
          owner_slack_user_ids = ?,
          bot_user_id = ?,
          bugs_and_updates_channel_id = ?,
          newton_web_path = ?,
          newton_api_path = ?,
          max_concurrent_jobs = ?,
          pr_review_timeout_ms = ?,
          bug_fix_timeout_ms = ?,
          repo_classifier_threshold = ?
      WHERE id = 1
    `).run(
      'xoxb-valid',
      'xapp-valid',
      'U1,U2',
      'UBOT',
      'C01H25RNLJH',
      '/Users/dipesh/code/newton-web',
      '/Users/dipesh/code/newton-api',
      2,
      720000,
      2700000,
      0.75,
    );

    db.close();

    const config = loadConfigFromDb(dbPath);
    expect(config.botUserId).toBe('UBOT');
    expect(config.ownerSlackUserIds).toEqual(['U1', 'U2']);
    expect(config.repoPaths.newtonWeb).toBe('/Users/dipesh/code/newton-web');
  });

  it('throws when required settings are missing', () => {
    const dbPath = makeDb();
    expect(() => loadConfigFromDb(dbPath)).toThrow('Settings incomplete');
  });
});
