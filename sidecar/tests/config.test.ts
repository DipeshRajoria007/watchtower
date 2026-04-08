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
      multi_agent_enabled INTEGER NOT NULL DEFAULT 0,
      agent_backend TEXT NOT NULL DEFAULT 'codex',
      pm_slack_user_ids TEXT NOT NULL DEFAULT '',
      pm_task_timeout_ms INTEGER NOT NULL DEFAULT 600000,
      core_dev_slack_user_ids TEXT NOT NULL DEFAULT '',
      core_dev_slack_user_group TEXT NOT NULL DEFAULT '',
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

    db.prepare(
      `
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
    `,
    ).run(
      'xoxb-valid',
      'xapp-valid',
      'U1,U2',
      'UBOT',
      'C01H25RNLJH, C02BUGS, C01H25RNLJH',
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
    expect(config.allowedChannelsForBugFix).toEqual(['C01H25RNLJH', 'C02BUGS']);
    expect(config.bugsAndUpdatesChannelId).toBe('C01H25RNLJH');
    expect(config.repoPaths.newtonWeb).toBe('/Users/dipesh/code/newton-web');
  });

  it('throws when required settings are missing', () => {
    const dbPath = makeDb();
    expect(() => loadConfigFromDb(dbPath)).toThrow('Settings incomplete');
  });

  it('loads access-control settings from dedicated tables when present', () => {
    const dbPath = makeDb();
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS access_control_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL DEFAULT 'audit',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT OR IGNORE INTO access_control_settings(id, mode) VALUES (1, 'enforce');

      CREATE TABLE IF NOT EXISTS access_control_groups (
        group_key TEXT PRIMARY KEY,
        slack_user_group_handle TEXT NOT NULL DEFAULT '',
        manual_user_ids TEXT NOT NULL DEFAULT '',
        allowed_channel_ids TEXT NOT NULL DEFAULT '',
        allow_im INTEGER NOT NULL DEFAULT 0,
        allow_mpim INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.prepare(
      `
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
    `,
    ).run(
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

    db.prepare(
      `
      INSERT INTO access_control_groups(
        group_key,
        slack_user_group_handle,
        manual_user_ids,
        allowed_channel_ids,
        allow_im,
        allow_mpim
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run('viewer', 'eng-viewers', 'U3', 'C-VIEW', 1, 0);
    db.prepare(
      `
      INSERT INTO access_control_groups(
        group_key,
        slack_user_group_handle,
        manual_user_ids,
        allowed_channel_ids,
        allow_im,
        allow_mpim
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run('reviewer', '', 'U4', 'C-REVIEW', 0, 0);
    db.prepare(
      `
      INSERT INTO access_control_groups(
        group_key,
        slack_user_group_handle,
        manual_user_ids,
        allowed_channel_ids,
        allow_im,
        allow_mpim
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run('builder', '', 'U5', 'C-BUILD', 0, 0);
    db.prepare(
      `
      INSERT INTO access_control_groups(
        group_key,
        slack_user_group_handle,
        manual_user_ids,
        allowed_channel_ids,
        allow_im,
        allow_mpim
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run('admin', 'platform-admins', 'U6', 'C-ADMIN', 1, 1);

    db.close();

    const config = loadConfigFromDb(dbPath);
    expect(config.accessControl?.mode).toBe('enforce');
    expect(config.accessControl?.groups.viewer.slackUserGroupHandle).toBe('eng-viewers');
    expect(config.accessControl?.groups.viewer.resolvedUserIds).toEqual(['U3']);
    expect(config.accessControl?.groups.admin.resolvedUserIds).toEqual(['U1', 'U2', 'U6']);
    expect(config.accessControl?.groups.admin.allowIm).toBe(true);
  });
});
