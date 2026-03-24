import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
let cachedTokenPromise: Promise<string | undefined> | null = null;

function buildGhSearchPath(): string {
  const base = process.env.PATH ?? '';
  const home = process.env.HOME?.trim() || os.homedir();
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', home ? path.join(home, '.local', 'bin') : ''].filter(Boolean);
  const dirs = new Set([...extra, ...base.split(path.delimiter)]);
  return [...dirs].join(path.delimiter);
}

async function resolveFromGhCli(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: buildGhSearchPath() },
    });
    const token = stdout.trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveGithubTokenForCodex(): Promise<string | undefined> {
  const envToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  if (!cachedTokenPromise) {
    cachedTokenPromise = resolveFromGhCli();
  }

  return cachedTokenPromise;
}

export function githubAuthModeHint(tokenResolved: boolean): string {
  if (tokenResolved) {
    return 'GitHub auth is injected from gh CLI token.';
  }
  return 'No injected token found; use authenticated GitHub MCP tools available to Codex.';
}
