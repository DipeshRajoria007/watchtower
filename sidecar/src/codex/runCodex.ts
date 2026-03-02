import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CodexRunRequest, CodexRunResult } from '../types/contracts.js';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error('CODex_TIMEOUT'));
    }, timeoutMs);

    promise
      .then(value => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export async function runCodex(request: CodexRunRequest): Promise<CodexRunResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watchtower-codex-'));
  const outputPath = path.join(tempDir, 'final-message.txt');

  const args = ['exec', '--cd', request.cwd, '--full-auto', '--skip-git-repo-check'];
  if (request.outputSchemaPath) {
    args.push('--output-schema', request.outputSchemaPath);
  }
  args.push('--output-last-message', outputPath, request.prompt);

  const env = { ...process.env };
  if (request.githubToken) {
    env.GITHUB_TOKEN = request.githubToken;
    env.GH_TOKEN = request.githubToken;
  }

  let timedOut = false;
  const child = spawn('codex', args, {
    cwd: request.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  try {
    const exitCode = await withTimeout(
      new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => resolve(code));
      }),
      request.timeoutMs,
      () => {
        timedOut = true;
        child.kill('SIGKILL');
      }
    );

    let lastMessage = '';
    try {
      lastMessage = await fs.readFile(outputPath, 'utf8');
    } catch {
      lastMessage = '';
    }

    let parsedJson: Record<string, unknown> | undefined;
    try {
      parsedJson = JSON.parse(lastMessage) as Record<string, unknown>;
    } catch {
      parsedJson = undefined;
    }

    return {
      ok: !timedOut && exitCode === 0,
      exitCode,
      timedOut,
      stdout,
      stderr,
      lastMessage,
      parsedJson,
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      timedOut,
      stdout,
      stderr: `${stderr}\n${String(error)}`,
      lastMessage: '',
    };
  } finally {
    void fs.rm(tempDir, { recursive: true, force: true });
  }
}
