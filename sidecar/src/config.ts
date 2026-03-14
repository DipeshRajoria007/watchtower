import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { AgentBackendId, AppConfig } from './types/contracts.js';

const settingsSchema = z.object({
  slack_bot_token: z.string(),
  slack_app_token: z.string(),
  owner_slack_user_ids: z.string(),
  bot_user_id: z.string(),
  bugs_and_updates_channel_id: z.string().default('C01H25RNLJH'),
  newton_web_path: z.string(),
  newton_api_path: z.string(),
  max_concurrent_jobs: z.number().int().positive().default(2),
  pr_review_timeout_ms: z.number().int().positive().default(720000),
  bug_fix_timeout_ms: z.number().int().positive().default(2700000),
  repo_classifier_threshold: z.number().min(0).max(1).default(0.75),
  multi_agent_enabled: z.number().int().min(0).max(1).default(0),
  agent_backend: z.string().default('codex'),
  pm_slack_user_ids: z.string().default(''),
  pm_task_timeout_ms: z.number().int().positive().default(600000),
});

type SettingsRow = z.infer<typeof settingsSchema>;

function mustBeAbsoluteExistingDir(p: string, label: string): string {
  if (!path.isAbsolute(p)) {
    throw new Error(`${label} must be an absolute path: ${p}`);
  }
  const real = fs.realpathSync(p);
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) {
    throw new Error(`${label} must point to an existing directory: ${real}`);
  }
  return real;
}

function parseOwnerIds(raw: string): string[] {
  return raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function parseChannelIds(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of raw.split(',')) {
    const id = value.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }

  return result;
}

export function loadConfigFromDb(dbPath: string): AppConfig {
  const db = new Database(dbPath);

  try {
    const row = db
      .prepare(
        `SELECT
          slack_bot_token,
          slack_app_token,
          owner_slack_user_ids,
          bot_user_id,
          bugs_and_updates_channel_id,
          newton_web_path,
          newton_api_path,
          max_concurrent_jobs,
          pr_review_timeout_ms,
          bug_fix_timeout_ms,
          repo_classifier_threshold,
          COALESCE(multi_agent_enabled, 0) AS multi_agent_enabled,
          COALESCE(agent_backend, 'codex') AS agent_backend,
          COALESCE(pm_slack_user_ids, '') AS pm_slack_user_ids,
          COALESCE(pm_task_timeout_ms, 600000) AS pm_task_timeout_ms
         FROM app_settings
         WHERE id = 1
         LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error('Settings row missing; open app settings page and save configuration.');
    }

    const parsed = settingsSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`Invalid settings row: ${parsed.error.message}`);
    }

    return mapSettingsToConfig(parsed.data);
  } finally {
    db.close();
  }
}

export function readAgentBackend(dbPath: string): AgentBackendId {
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare(`SELECT COALESCE(agent_backend, 'codex') AS agent_backend FROM app_settings WHERE id = 1 LIMIT 1`)
      .get() as { agent_backend?: string } | undefined;
    return ((row?.agent_backend || 'codex') as AgentBackendId);
  } finally {
    db.close();
  }
}

function mapSettingsToConfig(settings: SettingsRow): AppConfig {
  const ownerSlackUserIds = parseOwnerIds(settings.owner_slack_user_ids);
  const bugFixChannelIds = parseChannelIds(settings.bugs_and_updates_channel_id);

  const missingFields: string[] = [];
  if (!settings.slack_bot_token.trim()) missingFields.push('slack_bot_token');
  if (!settings.slack_app_token.trim()) missingFields.push('slack_app_token');
  if (!settings.bot_user_id.trim()) missingFields.push('bot_user_id');
  if (ownerSlackUserIds.length === 0) missingFields.push('owner_slack_user_ids');
  if (bugFixChannelIds.length === 0) missingFields.push('bugs_and_updates_channel_id');
  if (!settings.newton_web_path.trim()) missingFields.push('newton_web_path');
  if (!settings.newton_api_path.trim()) missingFields.push('newton_api_path');

  if (missingFields.length > 0) {
    throw new Error(
      `Settings incomplete (${missingFields.join(', ')}). Update Watchtower settings in the desktop app.`
    );
  }

  const newtonWeb = mustBeAbsoluteExistingDir(settings.newton_web_path, 'newton_web_path');
  const newtonApi = mustBeAbsoluteExistingDir(settings.newton_api_path, 'newton_api_path');

  const pmSlackUserIds = parseOwnerIds(settings.pm_slack_user_ids);

  return {
    platformPolicy: 'macos_only',
    bundleTargets: ['app', 'dmg'],
    ownerSlackUserIds,
    pmSlackUserIds,
    botUserId: settings.bot_user_id.trim(),
    slackBotToken: settings.slack_bot_token.trim(),
    slackAppToken: settings.slack_app_token.trim(),
    bugsAndUpdatesChannelId: bugFixChannelIds[0],
    allowedChannelsForBugFix: bugFixChannelIds,
    repoPaths: {
      newtonWeb,
      newtonApi,
    },
    workflowTimeouts: {
      prReviewMs: settings.pr_review_timeout_ms,
      bugFixMs: settings.bug_fix_timeout_ms,
      pmTaskMs: settings.pm_task_timeout_ms,
    },
    unknownTaskPolicy: 'desktop_only',
    uncertainRepoPolicy: 'desktop_only',
    unmappedPrRepoPolicy: 'desktop_only',
    maxConcurrentJobs: settings.max_concurrent_jobs,
    repoClassifierThreshold: settings.repo_classifier_threshold,
    allowedPrOrg: 'Newton-School',
    multiAgentEnabled: Boolean(settings.multi_agent_enabled),
    agentBackend: (settings.agent_backend || 'codex') as AgentBackendId,
  };
}
