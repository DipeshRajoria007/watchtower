import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DiffCapture {
  branchName: string;
  diffText: string;
  files: DiffFileEntry[];
  totalInsertions: number;
  totalDeletions: number;
}

export interface DiffFileEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  insertions: number;
  deletions: number;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const branch = await git(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short']);
    return branch.replace('origin/', '');
  } catch {
    // Fallback: check if 'main' exists, otherwise 'master'
    try {
      await git(repoPath, ['rev-parse', '--verify', 'main']);
      return 'main';
    } catch {
      return 'master';
    }
  }
}

export async function createBranch(repoPath: string, branchName: string): Promise<void> {
  const defaultBranch = await getDefaultBranch(repoPath);
  // Fetch latest from origin
  try {
    await git(repoPath, ['fetch', 'origin', defaultBranch]);
  } catch {
    // Offline or no remote — proceed from local state
  }
  await git(repoPath, ['checkout', '-b', branchName, `origin/${defaultBranch}`]);
}

export async function captureGitDiff(repoPath: string, baseBranch?: string): Promise<DiffCapture> {
  const base = baseBranch ?? await getDefaultBranch(repoPath);
  const branchName = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const diffText = await git(repoPath, ['diff', `${base}...HEAD`]);

  // Parse --numstat for per-file stats
  const numstat = await git(repoPath, ['diff', '--numstat', `${base}...HEAD`]);
  const nameStatus = await git(repoPath, ['diff', '--name-status', `${base}...HEAD`]);

  const statusMap = new Map<string, 'added' | 'modified' | 'deleted'>();
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const [statusChar, ...pathParts] = line.split('\t');
    const filePath = pathParts.join('\t');
    if (statusChar?.startsWith('A')) statusMap.set(filePath, 'added');
    else if (statusChar?.startsWith('D')) statusMap.set(filePath, 'deleted');
    else statusMap.set(filePath, 'modified');
  }

  const files: DiffFileEntry[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [ins, del, ...pathParts] = line.split('\t');
    const filePath = pathParts.join('\t');
    const insertions = ins === '-' ? 0 : Number(ins);
    const deletions = del === '-' ? 0 : Number(del);
    totalInsertions += insertions;
    totalDeletions += deletions;
    files.push({
      path: filePath,
      status: statusMap.get(filePath) ?? 'modified',
      insertions,
      deletions,
    });
  }

  return { branchName, diffText, files, totalInsertions, totalDeletions };
}

export async function pushBranch(repoPath: string, branchName: string): Promise<void> {
  await git(repoPath, ['push', '-u', 'origin', branchName]);
}
