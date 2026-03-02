import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppConfig } from './types/contracts.js';

const schema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1),
  SLACK_OWNER_USER_IDS: z.string().min(1),
  SLACK_BOT_USER_ID: z.string().min(1),
  BUGS_AND_UPDATES_CHANNEL_ID: z.string().default('C01H25RNLJH'),
  NEWTON_WEB_PATH: z.string().default('/Users/dipesh/code/newton-web'),
  NEWTON_API_PATH: z.string().default('/Users/dipesh/code/newton-api'),
  MAX_CONCURRENT_JOBS: z.string().default('2'),
  PR_REVIEW_TIMEOUT_MS: z.string().default('720000'),
  BUG_FIX_TIMEOUT_MS: z.string().default('2700000'),
  REPO_CLASSIFIER_THRESHOLD: z.string().default('0.75'),
});

function mustBeAbsoluteExistingDir(p: string): string {
  if (!path.isAbsolute(p)) {
    throw new Error(`Path must be absolute: ${p}`);
  }
  const real = fs.realpathSync(p);
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) {
    throw new Error(`Path must be a directory: ${real}`);
  }
  return real;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid env config: ${parsed.error.message}`);
  }

  const ownerSlackUserIds = parsed.data.SLACK_OWNER_USER_IDS.split(',')
    .map(value => value.trim())
    .filter(Boolean);

  const newtonWeb = mustBeAbsoluteExistingDir(parsed.data.NEWTON_WEB_PATH);
  const newtonApi = mustBeAbsoluteExistingDir(parsed.data.NEWTON_API_PATH);

  return {
    platformPolicy: 'macos_only',
    bundleTargets: ['app', 'dmg'],
    ownerSlackUserIds,
    botUserId: parsed.data.SLACK_BOT_USER_ID,
    slackBotToken: parsed.data.SLACK_BOT_TOKEN,
    slackAppToken: parsed.data.SLACK_APP_TOKEN,
    bugsAndUpdatesChannelId: parsed.data.BUGS_AND_UPDATES_CHANNEL_ID,
    allowedChannelsForBugFix: [parsed.data.BUGS_AND_UPDATES_CHANNEL_ID],
    repoPaths: {
      newtonWeb,
      newtonApi,
    },
    workflowTimeouts: {
      prReviewMs: Number(parsed.data.PR_REVIEW_TIMEOUT_MS),
      bugFixMs: Number(parsed.data.BUG_FIX_TIMEOUT_MS),
    },
    unknownTaskPolicy: 'desktop_only',
    uncertainRepoPolicy: 'desktop_only',
    unmappedPrRepoPolicy: 'desktop_only',
    maxConcurrentJobs: Number(parsed.data.MAX_CONCURRENT_JOBS),
    repoClassifierThreshold: Number(parsed.data.REPO_CLASSIFIER_THRESHOLD),
    allowedPrOrg: 'Newton-School',
  };
}
