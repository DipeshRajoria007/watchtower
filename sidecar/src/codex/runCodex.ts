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

  request.onLog?.({
    stage: 'codex.prepare',
    message: 'Preparing Codex command invocation.',
    data: {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      schemaEnabled: Boolean(request.outputSchemaPath),
      reasoningEffort: request.reasoningEffort ?? 'default',
      githubTokenInjected: Boolean(request.githubToken),
    },
  });

  const args = ['exec', '--cd', request.cwd, '--full-auto', '--skip-git-repo-check'];
  if (request.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${request.reasoningEffort}"`);
  }
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

  request.onLog?.({
    stage: 'codex.spawned',
    message: 'Codex process spawned.',
    data: {
      pid: child.pid ?? null,
    },
  });

  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutStarted = false;
  let stderrStarted = false;

  child.stdout.on('data', chunk => {
    const text = chunk.toString();
    stdout += text;
    stdoutBytes += Buffer.byteLength(text);
    if (!stdoutStarted) {
      stdoutStarted = true;
      request.onLog?.({
        stage: 'codex.stdout.start',
        message: 'Codex started streaming stdout.',
      });
    }
  });
  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderr += text;
    stderrBytes += Buffer.byteLength(text);
    if (!stderrStarted) {
      stderrStarted = true;
      request.onLog?.({
        stage: 'codex.stderr.start',
        message: 'Codex started streaming stderr.',
        level: 'WARN',
      });
    }
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
        request.onLog?.({
          stage: 'codex.timeout',
          message: 'Codex execution exceeded timeout and was force-killed.',
          level: 'ERROR',
          data: {
            timeoutMs: request.timeoutMs,
          },
        });
        child.kill('SIGKILL');
      }
    );

    request.onLog?.({
      stage: 'codex.process.exit',
      message: 'Codex process exited.',
      data: {
        exitCode,
        timedOut,
        stdoutBytes,
        stderrBytes,
      },
    });

    let lastMessage = '';
    try {
      lastMessage = await fs.readFile(outputPath, 'utf8');
      request.onLog?.({
        stage: 'codex.output.read',
        message: 'Read deterministic final output file from Codex.',
        data: {
          outputPath,
          bytes: Buffer.byteLength(lastMessage),
        },
      });
    } catch {
      lastMessage = '';
      request.onLog?.({
        stage: 'codex.output.missing',
        message: 'Codex final output file was not readable.',
        level: 'WARN',
        data: {
          outputPath,
        },
      });
    }

    let parsedJson: Record<string, unknown> | undefined;
    try {
      parsedJson = JSON.parse(lastMessage) as Record<string, unknown>;
      request.onLog?.({
        stage: 'codex.output.parsed',
        message: 'Parsed Codex final output as JSON.',
      });
    } catch {
      parsedJson = undefined;
      request.onLog?.({
        stage: 'codex.output.parse_failed',
        message: 'Codex final output is not valid JSON.',
        level: 'WARN',
      });
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
    request.onLog?.({
      stage: 'codex.execution.error',
      message: 'Codex process execution threw before completion.',
      level: 'ERROR',
      data: {
        error: String(error),
      },
    });

    return {
      ok: false,
      exitCode: null,
      timedOut,
      stdout,
      stderr: `${stderr}\n${String(error)}`,
      lastMessage: '',
    };
  } finally {
    request.onLog?.({
      stage: 'codex.cleanup',
      message: 'Cleaning up temporary Codex output directory.',
      data: {
        tempDir,
      },
    });
    void fs.rm(tempDir, { recursive: true, force: true });
  }
}
