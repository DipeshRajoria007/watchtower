import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPullRequest } from './createPr.js';
import { logger } from '../logging/logger.js';
import { sanitizeForBranch, buildSlackThreadLink } from '../workflows/shared/workflowUtils.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout.trim();
}

async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const status = await git(cwd, ['status', '--porcelain']);
  return status.length > 0;
}

async function getDefaultBranch(cwd: string): Promise<string> {
  try {
    const ref = await git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short']);
    return ref.replace('origin/', '');
  } catch {
    return 'main';
  }
}

/** Check if the current branch has commits ahead of the base branch. */
async function hasCommitsAheadOfBase(cwd: string, baseBranch: string): Promise<boolean> {
  try {
    const count = await git(cwd, ['rev-list', '--count', `origin/${baseBranch}..HEAD`]);
    return Number(count) > 0;
  } catch {
    return false;
  }
}

/** Returns { commitCount, changedFiles } for HEAD vs origin/<baseBranch>. */
async function scopeAheadOfBase(
  cwd: string,
  baseBranch: string,
): Promise<{ commitCount: number; changedFiles: string[] }> {
  try {
    const countStr = await git(cwd, ['rev-list', '--count', `origin/${baseBranch}..HEAD`]);
    const filesStr = await git(cwd, ['diff', '--name-only', `origin/${baseBranch}..HEAD`]);
    const commitCount = Number(countStr) || 0;
    const changedFiles = filesStr.length > 0 ? filesStr.split('\n').filter(Boolean) : [];
    return { commitCount, changedFiles };
  } catch {
    return { commitCount: 0, changedFiles: [] };
  }
}

/**
 * Sanity-check the branch before push. Fails if:
 * - commit count exceeds maxCommits, OR
 * - any changed file does not match one of the planner's expected paths (when provided).
 *
 * Returns { ok: true } on pass, { ok: false, reason } on fail.
 */
export function validatePushScope(params: {
  commitCount: number;
  changedFiles: string[];
  expectedFiles?: string[];
  maxCommits: number;
}): { ok: true } | { ok: false; reason: string } {
  const { commitCount, changedFiles, expectedFiles, maxCommits } = params;

  if (commitCount > maxCommits) {
    return {
      ok: false,
      reason: `branch has ${commitCount} commits ahead of base (max allowed: ${maxCommits}). Worktree likely started from a branch with unmerged commits.`,
    };
  }

  if (expectedFiles && expectedFiles.length > 0) {
    const normalizedExpected = expectedFiles.map(f => f.replace(/^\.?\//, ''));
    const unexpected = changedFiles.filter(f => {
      const norm = f.replace(/^\.?\//, '');
      return !normalizedExpected.some(exp => norm === exp || norm.endsWith(`/${exp}`) || exp.endsWith(`/${norm}`));
    });
    if (unexpected.length > 0) {
      return {
        ok: false,
        reason: `branch touches ${unexpected.length} file(s) outside the planner's scope: ${unexpected.slice(0, 5).join(', ')}${unexpected.length > 5 ? ', …' : ''}`,
      };
    }
  }

  return { ok: true };
}

/** Check if a PR already exists for the current branch. */
async function existingPrUrl(cwd: string): Promise<string | undefined> {
  try {
    const url = await git(cwd, ['ls-remote', '--get-url', 'origin']);
    if (!url) return undefined;
    const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') return undefined;
    const { stdout } = await execFileAsync('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], {
      cwd,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    const prUrl = stdout.trim();
    return prUrl || undefined;
  } catch {
    return undefined;
  }
}

/**
 * After a pipeline run, detect changes in the workspace and ensure a PR exists.
 *
 * Handles three scenarios:
 * 1. Uncommitted changes → create branch, commit, push, open PR
 * 2. Committed but unpushed changes → push, open PR
 * 3. Pushed but no PR → open PR
 *
 * Returns the PR URL if successful, or undefined if no changes or on failure.
 */
const DEFAULT_MAX_COMMITS = 10;

export async function createPrFromWorkspace(params: {
  repoPath: string;
  threadTs: string;
  summary: string;
  requestedBy?: string;
  channelId?: string;
  workflow?: string;
  expectedFiles?: string[];
  maxCommits?: number;
  onLog?: (msg: string) => void;
}): Promise<string | undefined> {
  const { repoPath, threadTs, summary, requestedBy, channelId, workflow, expectedFiles, onLog } = params;
  const maxCommits = params.maxCommits ?? DEFAULT_MAX_COMMITS;

  try {
    const baseBranch = await getDefaultBranch(repoPath);
    const currentBranch = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
    const hasUncommitted = await hasUncommittedChanges(repoPath);
    const hasAheadCommits = await hasCommitsAheadOfBase(repoPath, baseBranch);

    // Scenario: check if a PR already exists for the current branch
    if (!hasUncommitted && currentBranch !== 'HEAD' && currentBranch !== baseBranch) {
      const existing = await existingPrUrl(repoPath);
      if (existing) {
        onLog?.(`PR already exists for branch ${currentBranch}: ${existing}`);
        return existing;
      }
    }

    // No uncommitted changes AND no commits ahead of base → nothing to do
    if (!hasUncommitted && !hasAheadCommits) {
      onLog?.('No uncommitted or unpushed changes in workspace, skipping PR creation.');
      return undefined;
    }

    const safeBranchTs = threadTs.replace(/[^a-zA-Z0-9.-]/g, '-');
    let branchName = currentBranch;

    // If we need a new branch (detached HEAD or on base branch)
    if (currentBranch === 'HEAD' || currentBranch === baseBranch) {
      const branchPrefix = requestedBy ? `${sanitizeForBranch(requestedBy)}/` : '';
      branchName = `${branchPrefix}fix-${safeBranchTs}`;
      await git(repoPath, ['checkout', '-b', branchName]);
      onLog?.(`Created branch: ${branchName}`);
    }

    // Stage and commit any uncommitted changes
    if (hasUncommitted) {
      await git(repoPath, ['add', '-A']);
      const commitTitle = summary.length > 72 ? `${summary.slice(0, 69)}...` : summary;
      await git(repoPath, ['commit', '-m', commitTitle]);
      onLog?.('Committed changes.');
    }

    // Pre-push sanity check: abort if the branch carries unrelated commits
    // or touches files outside the planner's stated scope. This guards against
    // worktrees that accidentally started from a feature branch.
    const scope = await scopeAheadOfBase(repoPath, baseBranch);
    const validation = validatePushScope({
      commitCount: scope.commitCount,
      changedFiles: scope.changedFiles,
      expectedFiles,
      maxCommits,
    });
    if (!validation.ok) {
      const msg = `Refusing to push: ${validation.reason}`;
      logger.warn(
        { repoPath, branch: branchName, commitCount: scope.commitCount, changedFiles: scope.changedFiles },
        'pre-push validation failed',
      );
      onLog?.(msg);
      return undefined;
    }

    // Push the branch
    await git(repoPath, ['push', '-u', 'origin', branchName]);
    onLog?.(`Pushed to origin/${branchName}.`);

    // Check again if a PR already exists (coder may have pushed + created one)
    const existingAfterPush = await existingPrUrl(repoPath);
    if (existingAfterPush) {
      onLog?.(`PR already exists after push: ${existingAfterPush}`);
      return existingAfterPush;
    }

    // Create PR
    const rawTitle = summary.length > 72 ? `${summary.slice(0, 69)}...` : summary;
    const commitTitle = requestedBy ? `[${requestedBy} via miniOG] ${rawTitle}` : rawTitle;
    const slackLink = channelId ? buildSlackThreadLink(channelId, threadTs) : '';
    const threadLinkText = slackLink ? ` · [View thread](${slackLink})` : '';
    const prBody = [
      `> Requested by **${requestedBy ?? 'Unknown'}** via Slack${threadLinkText}`,
      '',
      '## Summary',
      summary,
      '',
      '---',
      '**Raised by:** miniOG (Watchtower)',
      ...(requestedBy ? [`**Triggered by:** ${requestedBy} via Slack`] : []),
      ...(channelId ? [`**Channel:** ${channelId}`] : []),
      ...(workflow ? [`**Workflow:** ${workflow}`] : []),
      `**Thread:** ${threadTs}`,
    ].join('\n');

    const { prUrl } = await createPullRequest({
      repoPath,
      title: commitTitle,
      body: prBody,
      branch: branchName,
      baseBranch,
      labels: ['miniog'],
    });

    onLog?.(`PR created: ${prUrl}`);
    return prUrl;
  } catch (error) {
    logger.warn({ repoPath, threadTs, error: String(error) }, 'failed to create PR from workspace changes');
    onLog?.(`PR creation failed: ${String(error)}`);
    return undefined;
  }
}
