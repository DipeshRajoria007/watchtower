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

/**
 * Deterministic substring check: returns the repo name if `files` unambiguously
 * point inside one of our known repos, else null. Shared between the initial
 * repo resolution and the post-revision recheck — revisions can swing a plan
 * from newton-api → newton-web (or vice versa) and the worktree must follow.
 *
 * Decision rule: a repo is "picked" only when its hits represent a CLEAR
 * MAJORITY of all paths (>50% AND strictly more than the other repo). This
 * prevents a single stray cross-repo reference from silently picking the
 * wrong worktree — the failure mode seen on Slack thread p1779196094091969
 * (2026-05-19), where a planner output 25 newton-web-relative paths plus
 * one context citation of `newton-api/courses/enums.py:955-960`, and the
 * pre-fix logic (any-hit-wins) routed the coder to newton-api with zero
 * code to actually edit.
 *
 * When the signal is ambiguous, return null and let the upstream AI repo
 * classifier (which is intent-aware) decide.
 */
export function inferRepoFromAffectedFiles(files: string[]): RepoName | null {
  if (files.length === 0) return null;
  const webHits = files.filter(f => f.includes('newton-web')).length;
  const apiHits = files.filter(f => f.includes('newton-api')).length;
  const total = files.length;
  const half = total / 2;
  if (webHits > apiHits && webHits >= half) return 'newton-web';
  if (apiHits > webHits && apiHits >= half) return 'newton-api';
  return null;
}

export function repoPathFor(name: RepoName, config: AppConfig): string {
  return name === 'newton-web' ? config.repoPaths.newtonWeb : config.repoPaths.newtonApi;
}

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
  // Deterministic substring check on file paths, not classification — calling
  // the agent here would just burn a round-trip.
  const fromFiles = inferRepoFromAffectedFiles(planAffectedFiles);
  if (fromFiles) return resolved(fromFiles, config, 'plan-affected-files');

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
    path: repoPathFor(name, config),
    source,
  };
}
