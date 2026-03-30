import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { extractReplyFromCodexResult } from './shared/workflowUtils.js';

/**
 * Resolves the deploy-prod skill instructions.
 * Reads from ~/.claude/commands/deploy-prod.md (the Claude Code skill definition).
 */
function loadDeploySkillInstructions(): string | undefined {
  const home = process.env.HOME?.trim() || os.homedir();
  const skillPath = path.join(home, '.claude', 'commands', 'deploy-prod.md');
  try {
    return fs.readFileSync(skillPath, 'utf8');
  } catch {
    return undefined;
  }
}

function buildDeployPrompt(params: { task: NormalizedTask; skillInstructions: string }): string {
  const { task, skillInstructions } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'DEPLOY' })}

You are running a production deployment for newton-web.

Follow the deployment instructions below EXACTLY. Do not deviate or add extra steps.

${skillInstructions}

Output rules:
Your response will be posted to a Slack thread. Write a clean, concise Slack message describing the outcome.
- On success: report the old hash, new hash, commit name, and commit URL.
- On fallback: report what happened and which commit was selected.
- On no-op: say prod is already on the latest.
- On freeze: say "deployment is freezed for now."
- On failure: report the error clearly.

Do NOT include JSON, code fences, or telemetry in your response. Just a clean Slack message.
`.trim();
}

export async function runDeployWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, logStep, signal } = params;

  logStep?.({
    stage: 'deploy.start',
    message: 'Running deploy workflow for newton-web production.',
  });

  // Only core-dev members can trigger deploys
  if (!config.coreDevSlackUserIds.includes(task.event.userId)) {
    const msg = 'Deploy to production is restricted to core-dev members.';
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: msg,
    });
    logStep?.({
      stage: 'deploy.denied',
      message: msg,
      level: 'WARN',
      data: { userId: task.event.userId },
    });
    return {
      workflow: 'DEPLOY',
      status: 'SKIPPED',
      message: msg,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  // Load skill instructions
  const skillInstructions = loadDeploySkillInstructions();
  if (!skillInstructions) {
    const msg = 'Deploy skill not found — missing `~/.claude/commands/deploy-prod.md`.';
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: msg,
    });
    logStep?.({
      stage: 'deploy.skill_missing',
      message: msg,
      level: 'ERROR',
    });
    return {
      workflow: 'DEPLOY',
      status: 'FAILED',
      message: msg,
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  // Post a progress message
  await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: 'Deploying newton-web to production...',
    })
    .catch(() => {});

  const prompt = buildDeployPrompt({ task, skillInstructions });
  const githubToken = await resolveGithubTokenForCodex();
  const cwd = config.repoPaths.newtonWeb;

  const result = await runCodex({
    cwd,
    prompt,
    githubToken,
    ...highReasoningProfile(getActiveBackendId()),
    onLog: logStep,
    signal,
  });

  logStep?.({
    stage: 'deploy.codex.done',
    message: 'Deploy codex execution finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: { ok: result.ok, exitCode: result.exitCode },
  });

  const reply = extractReplyFromCodexResult(result) || 'Deploy finished but produced no output. Check logs.';

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: reply,
  });

  logStep?.({
    stage: 'deploy.done',
    message: 'Deploy workflow completed.',
    data: { ok: result.ok },
  });

  return {
    workflow: 'DEPLOY',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    message: reply,
    notifyDesktop: true,
    slackPosted: true,
  };
}
