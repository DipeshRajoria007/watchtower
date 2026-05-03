import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logging/logger.js';
import { formatDossierForPrompt } from '../state/dossierStore.js';
import type { JobStore } from '../state/jobStore.js';
import type { WorkflowIntent } from '../types/contracts.js';
import { slugify, userNotePath } from '../vault/vaultPaths.js';
import { splitAutoBlock } from '../vault/vaultRenderer.js';

const RECALL_BLOCK_BEGIN = '=== USER CONTEXT (auto-generated, advisory) ===';
const RECALL_BLOCK_END = '=== END USER CONTEXT ===';

const DEFAULT_BUDGETS: Record<string, number> = {
  IMPLEMENTATION: 1500,
  INVESTIGATION: 1200,
  INFORMATIONAL: 1000,
  PR_REVIEW: 800,
};

const SIGNAL_LIMIT = 20;
const MEMORY_LIMIT = 8;
const VAULT_NOTE_TOKEN_BUDGET = 750;
const SIGNAL_TOKEN_BUDGET = 600;
const MEMORY_TOKEN_BUDGET = 600;
const PINNED_TOKEN_BUDGET = 300;

/**
 * Approximate token counter — char/4 is rough but stable enough for budget
 * decisions. We don't depend on a tokenizer library here; the assembler is
 * advisory and any over-budget block is dropped before it can hurt.
 */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clipToTokenBudget(text: string, tokenBudget: number): string {
  const charBudget = tokenBudget * 4;
  if (text.length <= charBudget) return text;
  return `${text.slice(0, charBudget - 1)}…`;
}

interface SignalLine {
  text: string;
  tokens: number;
}

function formatSignalLines(
  signals: ReadonlyArray<{
    intent: string | null;
    workflow: string | null;
    status: string | null;
    repo: string | null;
    errorKind: string | null;
    createdAt: string;
  }>,
): SignalLine[] {
  const out: SignalLine[] = [];
  for (const s of signals) {
    const date = (s.createdAt ?? '').slice(0, 10);
    const intent = s.intent ?? s.workflow ?? 'UNKNOWN';
    const status = s.status ?? '?';
    const repo = s.repo ? ` ${s.repo}` : '';
    const err = s.errorKind ? ` (${s.errorKind})` : '';
    const text = `[${date}] ${intent} ${status}${repo}${err}`;
    out.push({ text, tokens: approxTokens(text) });
  }
  return out;
}

async function readVaultOperatorRegion(opts: {
  vaultRoot?: string | null;
  userId: string;
  displayName?: string;
  realName?: string;
}): Promise<string | null> {
  const vaultRoot = (opts.vaultRoot ?? '').trim();
  if (!vaultRoot) return null;
  const slug = slugify(opts.displayName ?? opts.realName ?? opts.userId);
  const filePath = userNotePath(vaultRoot, slug);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    logger.debug({ err: String(err), filePath }, 'recall: vault note read failed');
    return null;
  }
  const split = splitAutoBlock(content);
  if (!split) {
    // No markers — treat the whole file body (sans frontmatter) as operator
    // content; fallthrough behavior matches composeFile's preservation case.
    return stripFrontmatter(content).trim() || null;
  }
  const before = stripFrontmatter(split.before).trim();
  const after = split.after.trim();
  const combined = [before, after].filter(Boolean).join('\n\n').trim();
  return combined || null;
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return raw;
  let cursor = end + 4;
  while (cursor < raw.length && (raw[cursor] === '\n' || raw[cursor] === '\r')) cursor++;
  return raw.slice(cursor);
}

export interface RecallInput {
  userId: string;
  workflow: WorkflowIntent;
  store: JobStore;
  vaultRoot?: string | null;
  /** Override the workflow-default token budget. */
  tokenBudget?: number;
}

export interface RecallOutput {
  /** Ready-to-splice prompt block. Empty string when no recall data is available. */
  promptBlock: string;
  estimatedTokens: number;
  sources: Array<'dossier' | 'signals' | 'vault' | 'pinned'>;
}

/**
 * Build a per-user context block for inclusion in a workflow prompt. Composes
 * (dossier summary, last N signals, vault operator notes), drops categories
 * to fit the token budget in the order vault → signals → dossier (dossier
 * survives as long as anything fits). Stable framing markers keep the block
 * cache-friendly when the same user re-queries.
 *
 * Returns an empty string when nothing useful is available — callers should
 * skip the block entirely rather than emit framing-only noise.
 */
export async function assembleRecall(input: RecallInput): Promise<RecallOutput> {
  const sources: RecallOutput['sources'] = [];
  const budget = input.tokenBudget ?? DEFAULT_BUDGETS[input.workflow] ?? 1000;

  // 1. Dossier summary (always tried first).
  let dossierSummary = '';
  try {
    const dossier = input.store.dossierStore().getDossier(input.userId);
    if (dossier.profile || dossier.affinity.length > 0) {
      dossierSummary = formatDossierForPrompt(dossier);
    }
  } catch (err) {
    logger.debug({ err: String(err) }, 'recall: dossier read failed');
  }

  // 2. Recent activity — prefer rich memory entries over bare-enum signal
  // lines. Fall back to signals if there are no memories yet (e.g. user has
  // history that predates the user_memories table).
  let signalsBlock = '';
  let dossierProfile: { displayName?: string; realName?: string } = {};
  try {
    const dossier = input.store.dossierStore().getDossier(input.userId);
    dossierProfile = {
      displayName: dossier.profile?.displayName,
      realName: dossier.profile?.realName,
    };

    const memoryRows = input.store.dossierStore().recentMemoriesForUser(input.userId, MEMORY_LIMIT);
    if (memoryRows.length > 0) {
      let used = 0;
      const kept: string[] = [];
      for (const m of memoryRows) {
        const date = (m.createdAt ?? '').slice(0, 10);
        const wf = m.workflow ?? 'WORK';
        const status = m.status ?? '?';
        const repo = m.repo ? ` ${m.repo}` : '';
        const pr = m.prUrl ? ` (${m.prUrl})` : '';
        const text = `[${date}] ${wf} ${status}${repo} — ${m.summary}${pr}`;
        const tokens = approxTokens(text);
        if (used + tokens > MEMORY_TOKEN_BUDGET) break;
        kept.push(text);
        used += tokens;
      }
      if (kept.length > 0) {
        signalsBlock = `Recent work:\n${kept.join('\n')}`;
      }
    }

    if (!signalsBlock) {
      // Fallback: bare enum lines for users with pre-Phase-A history only.
      const rows = input.store.recentSignalsForUser(input.userId, SIGNAL_LIMIT);
      const lines = formatSignalLines(rows);
      if (lines.length > 0) {
        let used = 0;
        const kept: string[] = [];
        for (const line of lines) {
          if (used + line.tokens > SIGNAL_TOKEN_BUDGET) break;
          kept.push(line.text);
          used += line.tokens;
        }
        if (kept.length > 0) {
          signalsBlock = `Recent activity:\n${kept.join('\n')}`;
        }
      }
    }
  } catch (err) {
    logger.debug({ err: String(err) }, 'recall: activity read failed');
  }

  // 3. Vault operator notes.
  let vaultBlock = '';
  const vaultRaw = await readVaultOperatorRegion({
    vaultRoot: input.vaultRoot,
    userId: input.userId,
    displayName: dossierProfile.displayName,
    realName: dossierProfile.realName,
  });
  if (vaultRaw) {
    vaultBlock = `Operator notes:\n${clipToTokenBudget(vaultRaw, VAULT_NOTE_TOKEN_BUDGET)}`;
  }

  // 4. User-pinned facts ("things to remember"). Highest priority — these
  // are explicit instructions the user gave miniOG, so they survive the
  // budget last.
  let pinnedBlock = '';
  try {
    const pinned = input.store.dossierStore().listPinnedFacts(input.userId);
    if (pinned.length > 0) {
      let used = 0;
      const kept: string[] = [];
      // Newest first (matches listPinnedFacts ordering); drop oldest if over budget.
      for (const fact of pinned) {
        const line = `- ${fact.text}`;
        const tokens = approxTokens(line);
        if (used + tokens > PINNED_TOKEN_BUDGET) break;
        kept.push(line);
        used += tokens;
      }
      if (kept.length > 0) {
        pinnedBlock = `Things to remember (the user told me):\n${kept.join('\n')}`;
      }
    }
  } catch (err) {
    logger.debug({ err: String(err) }, 'recall: pinned facts read failed');
  }

  // Drop categories until everything fits the budget. Drop order:
  // vault → signals → dossier → pinned. Pinned survives last because they
  // are explicit user instructions.
  const sections: Array<{ kind: 'pinned' | 'vault' | 'signals' | 'dossier'; text: string }> = [];
  if (vaultBlock) sections.push({ kind: 'vault', text: vaultBlock });
  if (signalsBlock) sections.push({ kind: 'signals', text: signalsBlock });
  if (dossierSummary) sections.push({ kind: 'dossier', text: dossierSummary });
  if (pinnedBlock) sections.push({ kind: 'pinned', text: pinnedBlock });

  const dropOrder: Array<'pinned' | 'vault' | 'signals' | 'dossier'> = ['vault', 'signals', 'dossier', 'pinned'];

  function totalTokens(): number {
    return sections.reduce((sum, s) => sum + approxTokens(s.text), 0);
  }

  while (totalTokens() > budget && sections.length > 0) {
    let dropped = false;
    for (const target of dropOrder) {
      const idx = sections.findIndex(s => s.kind === target);
      if (idx >= 0) {
        sections.splice(idx, 1);
        dropped = true;
        break;
      }
    }
    if (!dropped) break;
  }

  if (sections.length === 0) {
    return { promptBlock: '', estimatedTokens: 0, sources };
  }

  // Render order: pinned (most important) → dossier → signals → vault.
  const ordered: string[] = [];
  for (const kind of ['pinned', 'dossier', 'signals', 'vault'] as const) {
    const found = sections.find(s => s.kind === kind);
    if (found) {
      ordered.push(found.text);
      sources.push(kind);
    }
  }

  const body = ordered.join('\n\n');
  const promptBlock = `${RECALL_BLOCK_BEGIN}\n${body}\n${RECALL_BLOCK_END}`;
  return { promptBlock, estimatedTokens: approxTokens(promptBlock), sources };
}

export const __test__ = { approxTokens, RECALL_BLOCK_BEGIN, RECALL_BLOCK_END };

// TODO(v3-vectors): Replace "last N signals" with a top-K-similar-to-current
// query backed by sqlite-vec embeddings. Keeps the schema and assembler
// shape; only the inner SELECT changes. See plan: ~/.claude/plans/...
// for-now-i-dont-effervescent-finch.md, Phase v3.
const _ = path; // keep `path` import live for future TODO block
void _;
