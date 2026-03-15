import fsSync from 'node:fs';
import os from 'node:os';
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

function resolveClaudeCodeBinary(): string {
  const fromPath = findInPath('claude');
  if (fromPath) return fromPath;

  const home = process.env.HOME?.trim() || os.homedir();
  const absoluteCandidates = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    home ? path.join(home, '.claude', 'bin', 'claude') : '',
    home ? path.join(home, '.local', 'bin', 'claude') : '',
  ].filter(Boolean);

  for (const candidate of absoluteCandidates) {
    if (isExecutable(candidate)) return candidate;
  }

  return 'claude';
}

export const claudeCodeBackend: AgentBackend = {
  id: 'claude-code',
  displayName: 'Claude Code (Anthropic)',

  resolveBinary(): string {
    return resolveClaudeCodeBinary();
  },

  isAvailable(): boolean {
    try {
      const binary = resolveClaudeCodeBinary();
      if (binary !== 'claude') return true;
      return Boolean(findInPath('claude'));
    } catch {
      return false;
    }
  },

  supportsImages(): boolean {
    return true;
  },

  buildArgs(request: AgentRunRequest, outputPath: string): string[] {
    const args = [
      '-p', request.prompt,
      '--output-format', 'json',
      '--max-turns', '50',
      '--dangerously-skip-permissions',
    ];
    if (request.model) {
      args.push('--model', request.model);
    }
    if (request.imagePaths) {
      for (const imagePath of request.imagePaths) {
        args.push('--image', imagePath);
      }
    }
    // Claude Code writes JSON to stdout when --output-format json is set.
    // The generic runner captures stdout and falls back to it when the
    // output file is missing, so we do not pass an --output flag here.
    return args;
  },

  buildEnv(request: AgentRunRequest, basePath: string): Record<string, string> {
    const env: Record<string, string> = {};
    env.PATH = basePath;
    if (process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }
    if (request.githubToken) {
      env.GITHUB_TOKEN = request.githubToken;
      env.GH_TOKEN = request.githubToken;
    }
    return env;
  },

  parseOutput(raw: string): { parsedJson?: Record<string, unknown>; strategy?: string } {
    // Claude Code with --output-format json wraps the response in:
    // {"type":"result","subtype":"success","result":"<actual AI text>","session_id":"...","cost_usd":...}
    // We need to unwrap the "result" field first, then parse the inner content.
    const outerParsed = parseStructuredOutput(raw);
    if (
      outerParsed.parsedJson &&
      outerParsed.parsedJson.type === 'result' &&
      typeof outerParsed.parsedJson.result === 'string'
    ) {
      const innerText = (outerParsed.parsedJson.result as string).trim();
      // Try to parse the inner text as the structured JSON we asked the model to produce
      const innerParsed = parseStructuredOutput(innerText);
      if (innerParsed.parsedJson) {
        return { parsedJson: innerParsed.parsedJson, strategy: `claude_unwrap+${innerParsed.strategy}` };
      }
      // Inner text is plain text (not JSON) — surface it as a summary so workflows can use it
      return {
        parsedJson: { status: 'success', summary: innerText, actions: [], prUrl: '' },
        strategy: 'claude_unwrap+plain_text',
      };
    }
    // Fallback: not a Claude Code wrapper — try parsing raw output directly
    return outerParsed;
  },

  availableModels(): string[] {
    return ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'];
  },

  defaultModel(): string {
    return 'claude-sonnet-4-20250514';
  },
};
