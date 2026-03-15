import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function createPullRequest(params: {
  repoPath: string;
  title: string;
  body: string;
  branch: string;
  baseBranch?: string;
}): Promise<{ prUrl: string }> {
  const { repoPath, title, body, branch, baseBranch } = params;

  const args = [
    'pr', 'create',
    '--title', title,
    '--body', body,
    '--head', branch,
  ];

  if (baseBranch) {
    args.push('--base', baseBranch);
  }

  const { stdout } = await execFileAsync('gh', args, {
    cwd: repoPath,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });

  const prUrl = stdout.trim();
  return { prUrl };
}
