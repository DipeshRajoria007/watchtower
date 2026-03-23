import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { logger } from '../logging/logger.js';

const WORKSPACES_ROOT = path.join(os.homedir(), '.watchtower', 'workspaces');
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sanitizeThreadTs(threadTs: string): string {
  return threadTs.replace(/[^a-zA-Z0-9.-]/g, '_');
}

function repoNameFromPath(repoPath: string): string {
  return path.basename(repoPath);
}

function workspacePath(repoPath: string, threadTs: string): string {
  const repoName = repoNameFromPath(repoPath);
  const safeThread = sanitizeThreadTs(threadTs);
  return path.join(WORKSPACES_ROOT, repoName, safeThread);
}

function resolveDefaultRemoteBranch(repoPath: string): string {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 10_000,
    })
      .toString()
      .trim();
    // ref is like "origin/master" or "origin/main"
    return ref;
  } catch {
    return 'origin/master';
  }
}

/**
 * Resolves an isolated workspace for the given repo + thread.
 * Uses `git worktree` to create a lightweight checkout starting from
 * the default remote branch (origin/master or origin/main), NOT from
 * the local HEAD which may be on an unrelated feature branch.
 * Returns the original repoPath if worktree creation fails.
 */
export function resolveWorkspace(repoPath: string, threadTs: string): string {
  const wsPath = workspacePath(repoPath, threadTs);

  // If workspace already exists, reuse it
  if (fs.existsSync(wsPath)) {
    logger.info({ repoPath, threadTs, wsPath }, 'reusing existing workspace');
    return wsPath;
  }

  try {
    fs.mkdirSync(path.dirname(wsPath), { recursive: true });

    // Fetch latest from origin so the worktree starts from up-to-date code
    try {
      execSync('git fetch origin --quiet', {
        cwd: repoPath,
        stdio: 'pipe',
        timeout: 30_000,
      });
    } catch {
      logger.warn({ repoPath }, 'git fetch failed before worktree creation, proceeding with local state');
    }

    // Create a detached worktree from the default remote branch (not local HEAD)
    const defaultBranch = resolveDefaultRemoteBranch(repoPath);
    execSync(`git worktree add --detach "${wsPath}" ${defaultBranch}`, {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 30_000,
    });

    // Symlink parent node_modules so tools (Jest, ESLint, etc.) are available in the worktree
    const parentNodeModules = path.join(repoPath, 'node_modules');
    const worktreeNodeModules = path.join(wsPath, 'node_modules');
    if (fs.existsSync(parentNodeModules) && !fs.existsSync(worktreeNodeModules)) {
      try {
        fs.symlinkSync(parentNodeModules, worktreeNodeModules, 'junction');
        logger.info({ wsPath }, 'symlinked node_modules into worktree');
      } catch (symlinkError) {
        logger.warn({ wsPath, error: String(symlinkError) }, 'failed to symlink node_modules into worktree');
      }
    }

    logger.info({ repoPath, threadTs, wsPath, startPoint: defaultBranch }, 'created workspace via git worktree');
    return wsPath;
  } catch (error) {
    logger.warn(
      { repoPath, threadTs, wsPath, error: String(error) },
      'failed to create workspace, falling back to shared repo path',
    );
    return repoPath;
  }
}

/**
 * Removes the workspace worktree for a given repo + thread.
 * Non-fatal — errors are logged but do not propagate.
 */
export function cleanupWorkspace(repoPath: string, threadTs: string): void {
  const wsPath = workspacePath(repoPath, threadTs);

  if (!fs.existsSync(wsPath)) {
    return;
  }

  try {
    execSync(`git worktree remove --force "${wsPath}"`, {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 15_000,
    });
    logger.info({ repoPath, threadTs, wsPath }, 'cleaned up workspace');
  } catch (error) {
    logger.warn({ repoPath, threadTs, wsPath, error: String(error) }, 'failed to remove workspace worktree');
    // Best-effort fallback: remove directory
    try {
      fs.rmSync(wsPath, { recursive: true, force: true });
    } catch {
      // silently ignore
    }
  }
}

/**
 * Removes workspaces that haven't been modified in over 24 hours.
 * Intended to be called periodically (e.g., on startup or on a timer).
 */
export function cleanupStaleWorkspaces(): void {
  if (!fs.existsSync(WORKSPACES_ROOT)) {
    return;
  }

  const now = Date.now();
  let cleaned = 0;

  try {
    for (const repoDir of fs.readdirSync(WORKSPACES_ROOT)) {
      const repoWorkspacesDir = path.join(WORKSPACES_ROOT, repoDir);
      const stat = fs.statSync(repoWorkspacesDir);
      if (!stat.isDirectory()) continue;

      for (const threadDir of fs.readdirSync(repoWorkspacesDir)) {
        const wsPath = path.join(repoWorkspacesDir, threadDir);
        const wsStat = fs.statSync(wsPath);
        if (!wsStat.isDirectory()) continue;

        if (now - wsStat.mtimeMs > STALE_THRESHOLD_MS) {
          try {
            // Try git worktree remove first
            const gitDir = path.join(wsPath, '.git');
            if (fs.existsSync(gitDir)) {
              // Read the gitdir pointer to find the parent repo
              const gitContent = fs.readFileSync(gitDir, 'utf8').trim();
              const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/);
              if (gitdirMatch) {
                const worktreeGitDir = gitdirMatch[1];
                const parentGitDir = path.resolve(worktreeGitDir, '..', '..', '..');
                if (fs.existsSync(parentGitDir)) {
                  execSync(`git worktree remove --force "${wsPath}"`, {
                    cwd: parentGitDir,
                    stdio: 'pipe',
                    timeout: 15_000,
                  });
                  cleaned++;
                  continue;
                }
              }
            }
            // Fallback: just remove the directory
            fs.rmSync(wsPath, { recursive: true, force: true });
            cleaned++;
          } catch {
            // silently ignore individual cleanup failures
          }
        }
      }
    }
  } catch (error) {
    logger.warn({ error: String(error) }, 'error during stale workspace cleanup');
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'cleaned up stale workspaces');
  }
}
