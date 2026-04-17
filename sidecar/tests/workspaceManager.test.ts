import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The module reads os.homedir() at import time to compute WORKSPACES_ROOT,
// so we stub homedir before importing it.
let tmpHome: string;
let originalHome: string;

async function importFresh() {
  vi.resetModules();
  const mod = await import('../src/workspaces/workspaceManager.js');
  return mod;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
}

/**
 * Creates a bare "origin" repo, a source clone with:
 *  - a commit on master
 *  - a feature branch ahead of master by N commits, checked out as HEAD
 * Returns { sourceRepo, baseSha }.
 */
function setupRepoAheadOfMaster(root: string): { sourceRepo: string; baseSha: string } {
  const origin = path.join(root, 'origin.git');
  const source = path.join(root, 'source');
  fs.mkdirSync(origin);
  fs.mkdirSync(source);

  runGit(origin, ['init', '--bare', '-b', 'master']);

  runGit(source, ['init', '-b', 'master']);
  runGit(source, ['config', 'user.email', 'test@example.com']);
  runGit(source, ['config', 'user.name', 'Test']);
  runGit(source, ['remote', 'add', 'origin', origin]);

  fs.writeFileSync(path.join(source, 'README.md'), 'base\n');
  runGit(source, ['add', 'README.md']);
  runGit(source, ['commit', '-m', 'base']);
  runGit(source, ['push', '-u', 'origin', 'master']);
  const baseSha = runGit(source, ['rev-parse', 'HEAD']);

  runGit(source, ['checkout', '-b', 'feature/ahead']);
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(source, `f${i}.txt`), `feature ${i}\n`);
    runGit(source, ['add', `f${i}.txt`]);
    runGit(source, ['commit', '-m', `feature commit ${i}`]);
  }

  runGit(source, ['remote', 'set-head', 'origin', 'master']);

  return { sourceRepo: source, baseSha };
}

describe('resolveWorkspace', () => {
  beforeEach(() => {
    originalHome = os.homedir();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-workspace-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
    // Restore home for the next test
    void originalHome;
  });

  it('creates a worktree pinned to origin/master, not local HEAD', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-repo-'));
    try {
      const { sourceRepo, baseSha } = setupRepoAheadOfMaster(repoRoot);
      const { resolveWorkspace } = await importFresh();

      const wsPath = resolveWorkspace(sourceRepo, '1700000000.000100');

      expect(wsPath).not.toBe(sourceRepo);
      expect(fs.existsSync(wsPath)).toBe(true);

      // The worktree HEAD should be the base sha (detached at origin/master),
      // NOT any of the feature commits.
      const headSha = runGit(wsPath, ['rev-parse', 'HEAD']);
      expect(headSha).toBe(baseSha);

      // Confirm none of the feature-branch files are present in the worktree.
      expect(fs.existsSync(path.join(wsPath, 'f0.txt'))).toBe(false);
      expect(fs.existsSync(path.join(wsPath, 'f2.txt'))).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
