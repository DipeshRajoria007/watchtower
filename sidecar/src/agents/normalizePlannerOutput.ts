import type { AgentBackendId } from '../types/contracts.js';

export type PlanScope = 'small' | 'medium' | 'large';

export interface NormalizedPlannerOutput {
  planMarkdown: string;
  scope: PlanScope;
  requiresCodeChanges: boolean;
  clarificationNeeded: string | null;
  affectedFiles: string[];
}

function coerceScope(value: unknown): PlanScope {
  if (value === 'small' || value === 'medium' || value === 'large') return value;
  return 'medium';
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.trim())
    .filter(Boolean);
}

function coerceClarification(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function renderJsonPlanAsMarkdown(steps: string[], affectedFiles: string[]): string {
  const lines: string[] = [];
  if (steps.length > 0) {
    lines.push(...steps.map((step, i) => `${i + 1}. ${step}`));
  }
  if (affectedFiles.length > 0) {
    lines.push('');
    lines.push('**Affected files:**');
    lines.push(...affectedFiles.map(f => `- \`${f}\``));
  }
  return lines.join('\n').trim();
}

function extractScopeFromMarkdown(markdown: string): PlanScope {
  const match = markdown.match(/scope\s*[:=]\s*(small|medium|large)/i);
  if (match) {
    const tag = match[1].toLowerCase();
    if (tag === 'small' || tag === 'medium' || tag === 'large') return tag;
  }
  return 'medium';
}

const FILE_EXTENSION_PATTERN =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|sass|less|html|htm|yml|yaml|toml|ini|env|rs|go|py|rb|java|kt|swift|m|mm|c|cc|cpp|h|hpp|sh|bash|zsh|sql|prisma|graphql|gql|vue|svelte|astro|lock|conf|cfg)$/i;

function looksLikeFilePath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 200) return false;
  if (/\s/.test(candidate)) return false;
  if (/^https?:\/\//i.test(candidate)) return false;
  if (candidate.includes('(') || candidate.includes(')')) return false;
  if (candidate.includes('/')) return true;
  return FILE_EXTENSION_PATTERN.test(candidate);
}

function extractAffectedFilesFromMarkdown(markdown: string): string[] {
  const files = new Set<string>();
  const pattern = /`([^`\n]{1,200})`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const candidate = match[1].trim();
    if (looksLikeFilePath(candidate)) files.add(candidate);
  }
  return [...files];
}

export function normalizePlannerOutput(raw: unknown, backendId: AgentBackendId): NormalizedPlannerOutput {
  if (backendId === 'claude-code') {
    // Prefer an already-normalized field (idempotent re-normalize), then the
    // Claude-Code envelope's `summary` (plain-text fallback path), then a bare
    // string. The markdown is what the ExitPlanMode tool emits.
    const rawObj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
    const markdown =
      typeof rawObj?.planMarkdown === 'string'
        ? (rawObj.planMarkdown as string).trim()
        : typeof rawObj?.summary === 'string'
          ? (rawObj.summary as string).trim()
          : typeof raw === 'string'
            ? raw.trim()
            : '';

    const carriedFiles = coerceStringArray(rawObj?.affectedFiles);
    const affectedFiles = carriedFiles.length > 0 ? carriedFiles : extractAffectedFilesFromMarkdown(markdown);
    return {
      planMarkdown: markdown,
      scope: extractScopeFromMarkdown(markdown),
      requiresCodeChanges: true,
      clarificationNeeded: null,
      affectedFiles,
    };
  }

  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const steps = coerceStringArray(obj.plan);
  const affectedFiles = coerceStringArray(obj.affectedFiles);
  const scope = coerceScope(obj.scope);
  const requiresCodeChanges = typeof obj.requiresCodeChanges === 'boolean' ? obj.requiresCodeChanges : true;
  const clarificationNeeded = coerceClarification(obj.clarificationNeeded);

  return {
    planMarkdown: renderJsonPlanAsMarkdown(steps, affectedFiles),
    scope,
    requiresCodeChanges,
    clarificationNeeded,
    affectedFiles,
  };
}
