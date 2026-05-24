import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import { evaluateCapability } from '../access/control.js';
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
${buildMentionSystemPrompt({ task, workflow: 'DEPLOY', toneMode: task.toneMode })}

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

  // Belt-and-suspenders capability check. The router (`taskRouter.ts:221`)
  // has already enforced this for the DEPLOY intent before dispatch — this
  // second check guards against any future caller that reaches the workflow
  // without passing through the router (e.g. internal triggers, retries).
  const accessDecision = evaluateCapability({
    config,
    userId: task.event.userId,
    channelId: task.event.channelId,
    channelType: task.event.channelType,
    capability: 'deploy_prod',
  });

  if (!accessDecision.allowed) {
    const msg = accessDecision.reason ?? 'Deploy to production is restricted to admins.';
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: msg,
    });
    logStep?.({
      stage: 'deploy.denied',
      message: msg,
      level: 'WARN',
      data: { userId: task.event.userId, denyReason: accessDecision.denyReason },
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

  // The deploy side-effect (runCodex above) has already executed. Any failure to
  // post the final Slack reply must NOT escape this function: the shared retry
  // loop in index.ts treats transient errors (ETIMEDOUT, ECONNRESET, 429, SlackApiError)
  // as retryable and would re-enter the workflow, which would call runCodex again
  // and re-run the production deploy. A swallowed-and-logged Slack failure is
  // strictly safer than a duplicated deploy.
  const slackPosted = await postDeployReplyBestEffort({
    slack,
    channelId: task.event.channelId,
    threadTs: task.event.threadTs,
    text: reply,
    logStep,
  });

  logStep?.({
    stage: 'deploy.done',
    message: 'Deploy workflow completed.',
    data: { ok: result.ok, slackPosted },
  });

  return {
    workflow: 'DEPLOY',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    message: reply,
    notifyDesktop: true,
    slackPosted,
  };
}

/**
 * Post the deploy outcome to Slack with a bounded internal retry. Never throws —
 * a final post failure is logged and returned as `false` so the workflow can still
 * return SUCCESS/FAILED for the deploy itself without triggering the index.ts
 * transient retry loop that would re-execute runCodex().
 */
async function postDeployReplyBestEffort(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  text: string;
  logStep?: WorkflowStepLogger;
}): Promise<boolean> {
  const { slack, channelId, threadTs, text, logStep } = params;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
      return true;
    } catch (error) {
      const isLast = attempt === maxAttempts;
      logStep?.({
        stage: 'deploy.slack.post_failed',
        level: isLast ? 'ERROR' : 'WARN',
        message: `Deploy reply post failed (attempt ${attempt}/${maxAttempts}): ${String(error)}`,
        data: { attempt, lastAttempt: isLast },
      });
      if (isLast) return false;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return false;
}
