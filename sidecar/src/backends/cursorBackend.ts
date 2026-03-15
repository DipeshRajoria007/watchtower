import fsSync from 'node:fs';
import path, { delimiter as pathDelimiter } from 'node:path';
import type { AgentBackend, AgentRunRequest } from './types.js';
import { parseStructuredOutput } from './codexBackend.js';

function isExecutable(filePath: string): boolean {
  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(binary: string): string | undefined {
  const sourcePath = process.env.PATH ?? '';
  for (const dir of sourcePath.split(pathDelimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = path.join(trimmed, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function resolveCursorBinary(): string {
  const fromPath = findInPath('cursor');
  if (fromPath) return fromPath;

  const absoluteCandidates = [
    '/usr/local/bin/cursor',
    '/opt/homebrew/bin/cursor',
    '/Applications/Cursor.app/Contents/Resources/cursor',
  ];

  for (const candidate of absoluteCandidates) {
    if (isExecutable(candidate)) return candidate;
  }

  return 'cursor';
}

export const cursorBackend: AgentBackend = {
  id: 'cursor',
  displayName: 'Cursor',

  resolveBinary(): string {
    return resolveCursorBinary();
  },

  isAvailable(): boolean {
    try {
      const binary = resolveCursorBinary();
      if (binary !== 'cursor') return true;
      return Boolean(findInPath('cursor'));
    } catch {
      return false;
    }
  },

  supportsImages(): boolean {
    return false;
  },

  buildArgs(request: AgentRunRequest, outputPath: string): string[] {
    const args = [
      '--prompt', request.prompt,
      '--output', outputPath,
    ];
    if (request.model) {
      args.push('--model', request.model);
    }
    return args;
  },

  buildEnv(request: AgentRunRequest, basePath: string): Record<string, string> {
    const env: Record<string, string> = {};
    env.PATH = basePath;
    if (request.githubToken) {
      env.GITHUB_TOKEN = request.githubToken;
      env.GH_TOKEN = request.githubToken;
    }
    return env;
  },

  parseOutput(raw: string): { parsedJson?: Record<string, unknown>; strategy?: string } {
    return parseStructuredOutput(raw);
  },

  availableModels(): string[] {
    return ['claude-sonnet-4-20250514'];
  },

  defaultModel(): string {
    return 'claude-sonnet-4-20250514';
  },
};
