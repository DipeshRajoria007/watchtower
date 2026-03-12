import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path, { delimiter as pathDelimiter } from 'node:path';
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

export async function runCodex(request: CodexRunRequest): Promise<CodexRunResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watchtower-codex-'));
  const outputPath = path.join(tempDir, 'final-message.txt');

  const codexExecutable = resolveCodexBinary();

  request.onLog?.({
    stage: 'codex.prepare',
    message: 'Preparing Codex command invocation.',
    data: {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      schemaEnabled: Boolean(request.outputSchemaPath),
      model: request.model ?? 'default',
      reasoningEffort: request.reasoningEffort ?? 'default',
      githubTokenInjected: Boolean(request.githubToken),
      codexExecutable,
    },
  });

  const args = ['exec', '--cd', request.cwd, '--full-auto', '--skip-git-repo-check'];
  if (request.model) {
    args.push('-m', request.model);
  }
  if (request.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${request.reasoningEffort}"`);
  }
  if (request.outputSchemaPath) {
    args.push('--output-schema', request.outputSchemaPath);
  }
  args.push('--output-last-message', outputPath, request.prompt);

  const env = { ...process.env };
  env.PATH = buildCodexPath(env.PATH);
  if (request.githubToken) {
    env.GITHUB_TOKEN = request.githubToken;
    env.GH_TOKEN = request.githubToken;
  }

  let timedOut = false;
  const child = spawn(codexExecutable, args, {
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

    const parsedOutput = parseCodexStructuredOutput(lastMessage);
    const parsedJson = parsedOutput.parsedJson;
    if (parsedJson) {
      request.onLog?.({
        stage: 'codex.output.parsed',
        message: 'Parsed Codex final output as JSON.',
        data: {
          strategy: parsedOutput.strategy,
          preview: parsedOutput.preview,
        },
      });
    } else {
      request.onLog?.({
        stage: 'codex.output.parse_failed',
        message: 'Codex final output is not valid JSON.',
        level: 'WARN',
        data: {
          attempts: parsedOutput.attempts,
          preview: parsedOutput.preview,
        },
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
      stderr: `${stderr}\n${String(error)}${
        String(error).includes('ENOENT')
          ? '\nCodex executable not found. Set CODEX_BIN to an absolute path or install codex in /opt/homebrew/bin or /usr/local/bin.'
          : ''
      }`,
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

function resolveCodexBinary(): string {
  const envOverride = process.env.CODEX_BIN?.trim();
  if (envOverride) {
    if (path.isAbsolute(envOverride)) {
      if (isExecutable(envOverride)) {
        return envOverride;
      }
    } else {
      const fromPath = findInPath(envOverride, buildCodexPath(process.env.PATH));
      if (fromPath) {
        return fromPath;
      }
    }
  }

  const fromPath = findInPath('codex', buildCodexPath(process.env.PATH));
  if (fromPath) {
    return fromPath;
  }

  const home = process.env.HOME?.trim() || os.homedir();
  const nvmRoot = home ? path.join(home, '.nvm', 'versions', 'node') : '';
  const absoluteCandidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    home ? path.join(home, '.npm-global', 'bin', 'codex') : '',
    home ? path.join(home, '.local', 'bin', 'codex') : '',
    home ? path.join(home, '.bun', 'bin', 'codex') : '',
    ...findNvmCodexBinaries(nvmRoot),
  ].filter(Boolean);
  for (const candidate of absoluteCandidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return 'codex';
}

function isExecutable(filePath: string): boolean {
  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(binary: string, customPath?: string): string | undefined {
  const sourcePath = customPath ?? process.env.PATH ?? '';
  for (const dir of sourcePath.split(pathDelimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) {
      continue;
    }
    const candidate = path.join(trimmed, binary);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function buildCodexPath(existingPath?: string): string {
  const parts = new Set<string>();
  const add = (value?: string): void => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return;
    }
    parts.add(trimmed);
  };

  const currentNodeDir = path.dirname(process.execPath);
  add(currentNodeDir);
  add('/opt/homebrew/bin');
  add('/usr/local/bin');
  add('/usr/bin');
  add('/bin');

  const home = process.env.HOME?.trim() || os.homedir();
  if (home) {
    add(path.join(home, '.npm-global', 'bin'));
    add(path.join(home, '.local', 'bin'));
    add(path.join(home, '.bun', 'bin'));
    add(path.join(home, '.nvm', 'versions', 'node', 'current', 'bin'));
  }

  for (const value of (existingPath ?? '').split(pathDelimiter)) {
    add(value);
  }

  return Array.from(parts).join(pathDelimiter);
}

function findNvmCodexBinaries(nvmRoot: string): string[] {
  if (!nvmRoot || !fsSync.existsSync(nvmRoot)) {
    return [];
  }

  const versions = fsSync
    .readdirSync(nvmRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('v'))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a));

  const candidates: string[] = [];
  for (const version of versions) {
    candidates.push(path.join(nvmRoot, version, 'bin', 'codex'));
  }
  return candidates;
}
