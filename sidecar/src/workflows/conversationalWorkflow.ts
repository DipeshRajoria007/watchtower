import os from 'node:os';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { lightweightProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { fetchThreadContext } from '../slack/threadContext.js';
import type { InvestigationStore } from '../state/investigationStore.js';
import {
  formatThreadContext,
  stripMentions,
  isPresencePing,
  buildPresenceReply,
  extractReplyFromCodexResult,
} from './shared/workflowUtils.js';

// Regexes for the post-hoc steer: if the conversational agent (or any future
// model regression) tries to claim it shipped code, we rewrite the reply
// before posting. Kept narrow — only patterns that are clearly completion
// claims, not partial matches that could legitimately appear in casual chat.
const COMPLETION_CLAIM_RE =
  /\b(?:the\s+fix\s+is\s+done|fix\s+is\s+(?:up|deployed|merged|complete)|pr\s+is\s+(?:up|merged|open)|already\s+fixed|i(?:'ve|\s+have)\s+(?:fixed|opened|pushed|merged|deployed)|patch\s+is\s+up|all\s+exports\s+exist)\b/i;

export async function runConversationalWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  /**
   * Optional. When provided, the workflow checks for pending investigation
   * findings on this thread and applies a safety steer: replies cannot claim
   * code completion (no "fix is done", no PR links, no "I've pushed it") —
   * they must be steering replies ("on it", "starting now") instead.
   *
   * This is the belt-and-suspenders fallback to PR #299 (resume gate) and
   * the system-prompt rule below. If the router's resume gate ever misses a
   * tagged "yes" and we end up in CONVERSATIONAL with pending findings, the
   * reply still won't lie to the user.
   */
  investigationStore?: InvestigationStore;
  /** Honors cancellation from cancelJob() (e.g. when the source mention was deleted mid-run). */
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config: _config, slack, logStep, investigationStore, signal } = params;
  const userInput = stripMentions(task.event.text);
  const pendingFindings = investigationStore?.getForThread(task.event.threadTs);

  // Fast path: presence pings don't need an AI call
  if (isPresencePing(userInput)) {
    const presenceReply = buildPresenceReply(task.event.eventTs);
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: presenceReply,
    });

    logStep?.({
      stage: 'conversational.presence.reply_posted',
      message: 'Posted direct presence acknowledgement.',
      data: { userInput },
    });

    return {
      workflow: 'CONVERSATIONAL',
      status: 'SUCCESS',
      message: presenceReply,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  logStep?.({
    stage: 'conversational.start',
    message: 'Running conversational workflow.',
  });

  // Fetch thread context for conversation flow
  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs).catch(() => []);
  const threadContext = formatThreadContext(task, threadMessages);

  // Truthfulness guardrail. Today's RCA (Slack threads p1779086230428739 and
  // p1779086332488579, 2026-05-18) showed the conversational workflow
  // confidently posting "All exports exist. The fix is done." after a bare
  // "yes" reclassified to CONVERSATIONAL — no code change, no PR. This rule
  // is non-negotiable for every CONVERSATIONAL reply; the post-hoc rewrite
  // below (COMPLETION_CLAIM_RE) is the belt-and-suspenders fallback if a
  // future model ignores the rule.
  const TRUTH_GUARDRAIL = [
    'Truthfulness guardrail (non-negotiable):',
    '- You did NOT write code, open a PR, push a branch, deploy, or merge anything in this turn.',
    '- Do NOT claim "the fix is done", "PR is up", "I\'ve pushed it", "deployed", "merged", or any equivalent.',
    '- If the thread seems to want code work, steer with: "on it", "starting now", "will share the PR shortly".',
    '- If you are not sure whether work happened, default to a steering reply, not a completion claim.',
  ].join('\n');

  const prompt = `
${buildMentionSystemPrompt({ task, workflow: 'CONVERSATIONAL', toneMode: task.toneMode, dossierRole: task.dossierRole })}

Context:
- You are miniOG, a developer assistant bot in a Slack workspace.
- The user @mentioned you in a Slack thread with a casual/conversational message.
- Your response will be posted DIRECTLY into that Slack thread as-is. No transformation, no wrapping — what you write is exactly what the user sees.

Instructions:
- Reply naturally, briefly, and in a friendly tone. Be human.
- Write your response as a ready-to-post Slack message.
- Use Slack markdown if needed (*bold*, _italic_, \`code\`).
- No code changes, no file operations, no actions needed.

${TRUTH_GUARDRAIL}

Slack thread context:
${threadContext}
`.trim();

  const profile = lightweightProfile(getActiveBackendId());
  const result = await runCodex({
    cwd: os.tmpdir(),
    prompt,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    // timeoutMs: 30_000,
    onLog: logStep,
    signal,
  });

  let reply = extractReplyFromCodexResult(result) || "I'm here. What do you need?";

  // Post-hoc steer when an investigation is pending on this thread. If the
  // agent still produced a completion-claim reply despite the truth
  // guardrail in the prompt, rewrite it before posting. Logged so we can
  // see regressions in dashboards.
  if (pendingFindings && COMPLETION_CLAIM_RE.test(reply)) {
    const original = reply;
    reply =
      "On it — I'm picking up the investigation findings now. Will share the PR link in this thread when it's open.";
    logStep?.({
      stage: 'conversational.investigation_pending.steer_applied',
      level: 'WARN',
      message: 'Rewrote conversational reply that claimed code completion while investigation findings were pending.',
      data: {
        threadTs: task.event.threadTs,
        originalReply: original,
        rewrittenReply: reply,
      },
    });
  }

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: reply,
  });

  logStep?.({
    stage: 'conversational.done',
    message: 'Posted conversational reply.',
    data: pendingFindings ? { investigationPending: true } : undefined,
  });

  return {
    workflow: 'CONVERSATIONAL',
    status: 'SUCCESS',
    message: reply,
    notifyDesktop: false,
    slackPosted: true,
  };
}
