import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowStepLogger } from '../../types/contracts.js';
import { classifyRepo, type RepoAffinity } from '../../router/repoClassifier.js';
import { formatAdminMention, getAdminUserIds } from '../../access/control.js';
import { waitForRepoChoice } from '../../agents/pipeline.js';

export type RepoName = 'newton-web' | 'newton-api';
export type RepoResolution =
  | { outcome: 'resolved'; name: RepoName; path: string; source: ResolutionSource }
  | { outcome: 'desktop_only'; reason: string }
  | { outcome: 'cancelled' };

export type ResolutionSource = 'plan-affected-files' | 'classifier' | 'admin-choice';

export async function resolveRepoOrAsk(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  threadMessages: Array<{ text: string }>;
  planAffectedFiles?: string[];
  signal?: AbortSignal;
  askAdminsOnUncertain?: boolean;
  /**
   * Optional per-user repo affinity. Passed to the agent as advisory context;
   * the current task always dominates.
   */
  repoAffinity?: RepoAffinity;
}): Promise<RepoResolution> {
  const {
    task,
    config,
    slack,
    logStep,
    threadMessages,
    planAffectedFiles = [],
    signal,
    askAdminsOnUncertain = true,
    repoAffinity,
  } = params;

  // Fast path: the planner already named a path that lives in a known repo.
  // This is a deterministic substring check on file paths, not classification —
  // calling the agent here would just burn a round-trip.
  if (planAffectedFiles.length > 0) {
    const hasWebFiles = planAffectedFiles.some(f => f.includes('newton-web'));
    const hasApiFiles = planAffectedFiles.some(f => f.includes('newton-api'));
    if (hasWebFiles && !hasApiFiles) return resolved('newton-web', config, 'plan-affected-files');
    if (hasApiFiles && !hasWebFiles) return resolved('newton-api', config, 'plan-affected-files');
  }

  const classification = await classifyRepo({
    task: task.event.text,
    threadMessages: threadMessages.map(m => m.text),
    threshold: config.repoClassifierThreshold,
    affinity: repoAffinity,
    planAffectedFiles,
    logStep,
  });
  if (!classification.uncertain && classification.selectedRepo) {
    return resolved(classification.selectedRepo, config, 'classifier');
  }

  // 5. Still uncertain. Either ask admins (if enabled and any configured) or
  //    fall through to desktop-only per AppConfig.uncertainRepoPolicy.
  const adminUserIds = getAdminUserIds(config);
  if (!askAdminsOnUncertain || adminUserIds.length === 0) {
    logStep?.({
      stage: 'workflow.repo.desktop_only',
      message: 'Repo classifier uncertain and no admin gate available — routing to desktop.',
      level: 'WARN',
    });
    return {
      outcome: 'desktop_only',
      reason: adminUserIds.length === 0 ? 'no admins configured' : 'admin gate disabled by caller',
    };
  }

  logStep?.({
    stage: 'workflow.repo.clarify',
    message: 'Target repo is ambiguous — asking admins to clarify.',
    level: 'WARN',
  });

  // Use the core-dev subteam handle when available so we ping the group once
  // instead of unrolling every admin into a wall of individual `<@U…>` tags.
  const mentionStr = formatAdminMention(config);
  const promptText = `I can't tell whether this task is for *newton-web* or *newton-api*.${mentionStr ? ` ${mentionStr}` : ''} Reply with "web" or "api" (or "cancel" to abandon).`;

  let promptTs: string | undefined;
  try {
    const posted = await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: promptText,
    });
    promptTs = posted.ts ?? undefined;
  } catch {
    return {
      outcome: 'desktop_only',
      reason: 'could not post admin clarification prompt to Slack',
    };
  }
  if (!promptTs) {
    return {
      outcome: 'desktop_only',
      reason: 'slack did not return a timestamp for the clarification prompt',
    };
  }

  const choice = await waitForRepoChoice({
    slack,
    channelId: task.event.channelId,
    threadTs: task.event.threadTs,
    approverUserIds: adminUserIds,
    promptTs,
    logStep: logStep ?? (() => {}),
    botUserId: config.botUserId,
    signal,
    nudgeText:
      "Still waiting on an admin to pick *newton-web* or *newton-api* for this task. Reply here or say 'cancel' to stop.",
  });

  if (choice.outcome === 'cancelled') {
    return { outcome: 'cancelled' };
  }
  if (choice.outcome === 'timeout') {
    return {
      outcome: 'desktop_only',
      reason: 'no admin reply within idle window',
    };
  }
  if (choice.outcome === 'paused') {
    // Someone said "wait" mid-clarification. Treat as cancellation here — no
    // plan state has been built yet, so resume on the next mention is just a
    // fresh task with full thread context.
    return { outcome: 'cancelled' };
  }

  return resolved(choice.outcome, config, 'admin-choice');
}

function resolved(
  name: RepoName,
  config: AppConfig,
  source: ResolutionSource,
): Extract<RepoResolution, { outcome: 'resolved' }> {
  return {
    outcome: 'resolved',
    name,
    path: name === 'newton-web' ? config.repoPaths.newtonWeb : config.repoPaths.newtonApi,
    source,
  };
}
