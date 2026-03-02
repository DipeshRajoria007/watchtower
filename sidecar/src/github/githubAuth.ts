import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let cachedTokenPromise: Promise<string | undefined> | null = null;

async function resolveFromGhCli(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
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
