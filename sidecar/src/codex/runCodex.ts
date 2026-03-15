import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CodexRunRequest, CodexRunResult } from '../types/contracts.js';
import type { AgentBackend, AgentBackendId } from '../backends/types.js';
import { getBackend } from '../backends/registry.js';

let activeBackendId: AgentBackendId = 'codex';

export function setActiveBackend(id: AgentBackendId): void {
  activeBackendId = id;
}

export function getActiveBackendId(): AgentBackendId {
  return activeBackendId;
}

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

type ParsedCodexOutput = {
  parsedJson?: Record<string, unknown>;
  strategy?: 'direct' | 'fenced_block' | 'first_object';
  attempts: Array<'direct' | 'fenced_block' | 'first_object'>;
  preview: string;
};

function previewOutput(raw: string, maxChars = 220): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function extractFencedJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  while ((match = fenceRegex.exec(raw)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function extractFirstTopLevelJsonObject(raw: string): string | undefined {
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{') {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') {
        depth += 1;
        continue;
      }
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return raw.slice(start, index + 1).trim();
        }
      }
    }
  }

  return undefined;
}

export function parseCodexStructuredOutput(raw: string): ParsedCodexOutput {
  const attempts: Array<'direct' | 'fenced_block' | 'first_object'> = [];
  const preview = previewOutput(raw);

  attempts.push('direct');
  try {
    const parsedJson = parseJsonObject(raw.trim());
    if (parsedJson) {
      return { parsedJson, strategy: 'direct', attempts, preview };
    }
  } catch {
    // fall through to salvage strategies
  }

  attempts.push('fenced_block');
  for (const candidate of extractFencedJsonCandidates(raw)) {
    try {
      const parsedJson = parseJsonObject(candidate);
      if (parsedJson) {
        return { parsedJson, strategy: 'fenced_block', attempts, preview };
      }
    } catch {
      // continue to next candidate
    }
  }

  attempts.push('first_object');
  const firstObjectCandidate = extractFirstTopLevelJsonObject(raw);
  if (firstObjectCandidate) {
    try {
      const parsedJson = parseJsonObject(firstObjectCandidate);
      if (parsedJson) {
        return { parsedJson, strategy: 'first_object', attempts, preview };
      }
    } catch {
      // final strategy failed
    }
  }

  return {
    attempts,
    preview,
  };
}

export async function runAgent(request: CodexRunRequest, backend: AgentBackend): Promise<CodexRunResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `watchtower-${backend.id}-`));
  const outputPath = path.join(tempDir, 'final-message.txt');

  const executable = backend.resolveBinary();

  request.onLog?.({
    stage: 'agent.prepare',
    message: `Preparing ${backend.displayName} command invocation.`,
    data: {
      backend: backend.id,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      schemaEnabled: Boolean(request.outputSchemaPath),
      model: request.model ?? 'default',
      reasoningEffort: request.reasoningEffort ?? 'default',
      githubTokenInjected: Boolean(request.githubToken),
      executable,
    },
  });

  const args = backend.buildArgs(request, outputPath);
  const envOverrides = backend.buildEnv(request, process.env.PATH ?? '');
  const env = { ...process.env, ...envOverrides };

  let timedOut = false;
  const child = spawn(executable, args, {
    cwd: request.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  request.onLog?.({
    stage: 'agent.spawned',
    message: `${backend.displayName} process spawned.`,
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
        stage: 'agent.stdout.start',
        message: `${backend.displayName} started streaming stdout.`,
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
        stage: 'agent.stderr.start',
        message: `${backend.displayName} started streaming stderr.`,
        level: 'WARN',
      });
    }
  });

  try {
    const childDone = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => resolve(code));
    });

    const exitCode = request.timeoutMs
      ? await withTimeout(
          childDone,
          request.timeoutMs,
          () => {
            timedOut = true;
            request.onLog?.({
              stage: 'agent.timeout',
              message: `${backend.displayName} execution exceeded timeout and was force-killed.`,
              level: 'ERROR',
              data: {
                timeoutMs: request.timeoutMs,
              },
            });
            child.kill('SIGKILL');
          }
        )
      : await childDone;

    request.onLog?.({
      stage: 'agent.process.exit',
      message: `${backend.displayName} process exited.`,
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
        stage: 'agent.output.read',
        message: `Read deterministic final output file from ${backend.displayName}.`,
        data: {
          outputPath,
          bytes: Buffer.byteLength(lastMessage),
        },
      });
    } catch {
      // Output file not written — fall back to captured stdout (e.g. Claude Code
      // writes JSON to stdout rather than a file).
      lastMessage = stdout;
      request.onLog?.({
        stage: 'agent.output.missing',
        message: lastMessage
          ? `${backend.displayName} output file missing; falling back to stdout.`
          : `${backend.displayName} final output file was not readable.`,
        level: 'WARN',
        data: {
          outputPath,
          stdoutFallback: Boolean(lastMessage),
        },
      });
    }

    const parsedOutput = backend.parseOutput(lastMessage);
    const parsedJson = parsedOutput.parsedJson;
    if (parsedJson) {
      request.onLog?.({
        stage: 'agent.output.parsed',
        message: `Parsed ${backend.displayName} final output as JSON.`,
        data: {
          strategy: parsedOutput.strategy,
        },
      });
    } else {
      request.onLog?.({
        stage: 'agent.output.parse_failed',
        message: `${backend.displayName} final output is not valid JSON.`,
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
      stage: 'agent.execution.error',
      message: `${backend.displayName} process execution threw before completion.`,
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
      stderr: `${stderr}\n${String(error)}${
        String(error).includes('ENOENT')
          ? `\n${backend.displayName} executable not found. Ensure the CLI is installed and accessible from PATH.`
          : ''
      }`,
      lastMessage: '',
    };
  } finally {
    request.onLog?.({
      stage: 'agent.cleanup',
      message: `Cleaning up temporary ${backend.displayName} output directory.`,
      data: {
        tempDir,
      },
    });
    void fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function runCodex(request: CodexRunRequest): Promise<CodexRunResult> {
  return runAgent(request, getBackend(activeBackendId));
}
