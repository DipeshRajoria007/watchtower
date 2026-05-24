import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { AppConfig } from '../../types/contracts.js';

const execFileAsync = promisify(execFile);

const REPO_NAMES = ['newton-web', 'newton-api', 'watchtower'] as const;
type RepoName = (typeof REPO_NAMES)[number];

function resolveRepoPath(config: AppConfig, repo: RepoName): string | undefined {
  if (repo === 'newton-web') return config.repoPaths.newtonWeb;
  if (repo === 'newton-api') return config.repoPaths.newtonApi;
  if (repo === 'watchtower') return config.repoPaths.watchtower;
  return undefined;
}

/** Reject paths that escape the repo root (path traversal, absolute paths). */
function isSafeRelativePath(relative: string): boolean {
  if (!relative || relative.startsWith('/') || relative.startsWith('~')) return false;
  if (relative.includes('..')) return false;
  return true;
}

const searchArgsSchema = z.object({
  repo: z.enum(REPO_NAMES),
  query: z.string().min(1).max(200),
  max_results: z.number().int().positive().max(50).optional(),
});

export const searchCodebaseTool: ToolDefinition<typeof searchArgsSchema> = {
  name: 'search_codebase',
  description:
    'Grep a repository for a query string and return matching file paths with line numbers. Use this to find where something is defined or used. Returns at most max_results matches (default 25).',
  capability: 'query_codebase',
  inputSchema: searchArgsSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', enum: [...REPO_NAMES], description: 'Which repository to search.' },
      query: { type: 'string', description: 'Substring or regex to search for (passed to ripgrep / grep).' },
      max_results: { type: 'integer', minimum: 1, maximum: 50, description: 'Cap on returned matches.' },
    },
    required: ['repo', 'query'],
  },
  handler: async (args, context): Promise<ToolResult> => {
    const repoPath = resolveRepoPath(context.config, args.repo);
    if (!repoPath) {
      return {
        content: `Repo "${args.repo}" is not configured on this miniOG instance.`,
        isError: true,
      };
    }
    const maxResults = args.max_results ?? 25;
    try {
      const { stdout } = await execFileAsync('rg', ['--line-number', '--max-count', '3', args.query, repoPath], {
        timeout: 20_000,
        maxBuffer: 256 * 1024,
      });
      const lines = stdout
        .split('\n')
        .filter(Boolean)
        .slice(0, maxResults)
        .map(line => line.replace(`${repoPath}/`, ''));
      return {
        content: lines.length > 0 ? lines.join('\n') : `No matches for "${args.query}" in ${args.repo}.`,
        data: { matchCount: lines.length },
      };
    } catch (err: unknown) {
      const error = err as { code?: number; stderr?: string; message?: string };
      // ripgrep exit code 1 = no matches found (not an error).
      if (error.code === 1) {
        return { content: `No matches for "${args.query}" in ${args.repo}.`, data: { matchCount: 0 } };
      }
      return {
        content: `Search failed: ${error.stderr ?? error.message ?? 'unknown error'}`,
        isError: true,
      };
    }
  },
};

const readArgsSchema = z.object({
  repo: z.enum(REPO_NAMES),
  path: z.string().min(1).max(500),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
});

export const readFileTool: ToolDefinition<typeof readArgsSchema> = {
  name: 'read_file',
  description:
    'Read a file from a repository. Path is relative to the repo root. Optionally specify start_line and end_line to read a range (1-indexed, inclusive). Returns at most 500 lines.',
  capability: 'query_codebase',
  inputSchema: readArgsSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', enum: [...REPO_NAMES] },
      path: { type: 'string', description: 'Path relative to the repo root.' },
      start_line: { type: 'integer', minimum: 1, description: '1-indexed line to start reading from.' },
      end_line: { type: 'integer', minimum: 1, description: '1-indexed line to stop at (inclusive).' },
    },
    required: ['repo', 'path'],
  },
  handler: async (args, context): Promise<ToolResult> => {
    const repoPath = resolveRepoPath(context.config, args.repo);
    if (!repoPath) {
      return { content: `Repo "${args.repo}" is not configured.`, isError: true };
    }
    if (!isSafeRelativePath(args.path)) {
      return { content: `Refused: path "${args.path}" is unsafe.`, isError: true };
    }
    const absolute = path.join(repoPath, args.path);
    try {
      const contents = await fs.readFile(absolute, 'utf8');
      const lines = contents.split('\n');
      const start = Math.max(1, args.start_line ?? 1);
      const endRaw = args.end_line ?? lines.length;
      const end = Math.min(lines.length, endRaw, start + 499);
      const slice = lines.slice(start - 1, end);
      const numbered = slice.map((line, idx) => `${start + idx}\t${line}`).join('\n');
      return {
        content: numbered,
        data: { fileLength: lines.length, returnedLines: slice.length },
      };
    } catch (err) {
      return { content: `Could not read ${args.path}: ${String(err)}`, isError: true };
    }
  },
};

const listArgsSchema = z.object({
  repo: z.enum(REPO_NAMES),
  glob: z.string().min(1).max(200),
  max_results: z.number().int().positive().max(100).optional(),
});

export const listFilesTool: ToolDefinition<typeof listArgsSchema> = {
  name: 'list_files',
  description: 'List files in a repository matching a glob pattern (e.g. "src/**/*.tsx", "src/components/*.ts").',
  capability: 'query_codebase',
  inputSchema: listArgsSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', enum: [...REPO_NAMES] },
      glob: { type: 'string', description: 'Glob pattern relative to the repo root.' },
      max_results: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['repo', 'glob'],
  },
  handler: async (args, context): Promise<ToolResult> => {
    const repoPath = resolveRepoPath(context.config, args.repo);
    if (!repoPath) {
      return { content: `Repo "${args.repo}" is not configured.`, isError: true };
    }
    const maxResults = args.max_results ?? 50;
    try {
      // Use find with -path so we don't shell-out to a glob expander.
      // Convert the glob into a -path filter (find treats `*` and `?` natively for -path).
      const { stdout } = await execFileAsync(
        'sh',
        ['-c', `cd "${repoPath}" && find . -type f -path "./${args.glob}" 2>/dev/null | head -${maxResults}`],
        { timeout: 10_000, maxBuffer: 256 * 1024 },
      );
      const lines = stdout
        .split('\n')
        .filter(Boolean)
        .map(line => line.replace(/^\.\//, ''));
      return {
        content: lines.length > 0 ? lines.join('\n') : `No files match "${args.glob}" in ${args.repo}.`,
        data: { matchCount: lines.length },
      };
    } catch (err) {
      return { content: `list_files failed: ${String(err)}`, isError: true };
    }
  },
};
