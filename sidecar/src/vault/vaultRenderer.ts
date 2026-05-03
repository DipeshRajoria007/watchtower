import type { PinnedFactRow, UserDossier, UserMemoryRow } from '../state/dossierStore.js';
import { productDisplayName } from '../router/productClassifier.js';

/** Marker delimiting the operator-editable list inside the auto block. */
export const PINNED_LIST_BEGIN = '<!-- miniog:pinned-begin -->';
export const PINNED_LIST_END = '<!-- miniog:pinned-end -->';

export const AUTO_BEGIN_MARKER = '<!-- BEGIN miniog:auto -->';
export const AUTO_END_MARKER = '<!-- END miniog:auto -->';

interface FrontmatterFields {
  miniog_kind: 'user' | 'project' | 'daily' | 'meta';
  miniog_user_id?: string;
  miniog_repo?: string;
  miniog_date?: string;
  miniog_rendered_at: string;
}

function renderFrontmatter(fields: FrontmatterFields): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${value}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Compose a vault file body. Splits any prior content into pre/auto/post
 * buffers and replaces only the auto block. Anything outside the markers is
 * preserved verbatim — this is the contract Phase v2's watcher relies on.
 */
export function composeFile(params: {
  frontmatter: FrontmatterFields;
  autoBody: string;
  prior?: string;
  defaultOperatorTrailer?: string;
}): string {
  const { frontmatter, autoBody, prior, defaultOperatorTrailer } = params;
  const fm = renderFrontmatter(frontmatter);
  const autoBlock = `${AUTO_BEGIN_MARKER}\n${autoBody.trimEnd()}\n${AUTO_END_MARKER}`;

  if (!prior) {
    const trailer = defaultOperatorTrailer ? `\n\n${defaultOperatorTrailer.trim()}\n` : '\n';
    return `${fm}\n\n${autoBlock}${trailer}`;
  }

  const split = splitAutoBlock(prior);
  if (!split) {
    // No markers in prior content — append auto block at the end so we don't
    // overwrite operator's freeform notes.
    return `${stripFrontmatter(prior).trimEnd()}\n\n${autoBlock}\n`;
  }

  const beforeRaw = stripFrontmatter(split.before);
  const before = beforeRaw.trimEnd();
  const after = split.after.replace(/^\s+/, '');
  const beforeBlock = before ? `${before}\n\n` : '';
  const afterBlock = after ? `\n\n${after.trimEnd()}\n` : '\n';
  return `${fm}\n\n${beforeBlock}${autoBlock}${afterBlock}`;
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return raw;
  // Skip past the closing fence and any trailing newlines.
  let cursor = end + 4;
  while (cursor < raw.length && (raw[cursor] === '\n' || raw[cursor] === '\r')) cursor++;
  return raw.slice(cursor);
}

interface SplitResult {
  before: string;
  auto: string;
  after: string;
}

export function splitAutoBlock(raw: string): SplitResult | null {
  const beginIdx = raw.indexOf(AUTO_BEGIN_MARKER);
  const endIdx = raw.indexOf(AUTO_END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return null;
  const before = raw.slice(0, beginIdx);
  const auto = raw.slice(beginIdx + AUTO_BEGIN_MARKER.length, endIdx);
  const after = raw.slice(endIdx + AUTO_END_MARKER.length);
  return { before, auto, after };
}

function fmtRate(successes: number, hits: number): string {
  if (hits <= 0) return 'n/a';
  return `${Math.round((100 * successes) / hits)}%`;
}

/**
 * Markdown body for a single user's auto block.
 *
 * Layout (three sections inside the auto block):
 *   1. About — AI-inferred narrative when present (Phase C); otherwise a
 *      compact identity + activity summary derived from the dossier.
 *   2. Things to remember — bulleted list of `user_pinned_facts`, wrapped in
 *      hidden marker comments so the watcher can diff edits back to the DB.
 *   3. Recent work — last N entries from `user_memories`.
 *
 * Section 2 is a controlled exception to the "auto block is DB-truth" rule:
 * the watcher (Phase v2) treats edits to bullets *between* the
 * miniog:pinned-begin / miniog:pinned-end markers as authoritative and
 * mirrors them back into `user_pinned_facts`. All other auto-block edits
 * are still discarded on the next render.
 */
export function renderUserAutoBody(input: {
  dossier: UserDossier;
  pinnedFacts?: ReadonlyArray<PinnedFactRow>;
  memories?: ReadonlyArray<UserMemoryRow>;
}): string {
  const { dossier, pinnedFacts = [], memories = [] } = input;
  const profile = dossier.profile;
  const lines: string[] = [];

  // ── Section 1: About ────────────────────────────────────────────────
  lines.push('## About');
  const inferred = dossier.metrics['inferred_profile'] as { text?: string } | undefined;
  if (inferred?.text) {
    lines.push(inferred.text);
  } else {
    // Fallback prose until Phase C's nightly synthesizer fills this in.
    if (!profile) {
      lines.push("miniOG hasn't met this user yet.");
    } else {
      const name = profile.displayName ?? profile.realName ?? profile.userId;
      const fragments: string[] = [`*${name}* (\`${profile.userId}\`)`];
      if (profile.role) fragments.push(`role *${profile.role}*`);

      const topRepo = dossier.affinity[0];
      if (topRepo && topRepo.hits >= 3) {
        fragments.push(
          `mostly on \`${topRepo.repo}\` (${topRepo.hits} jobs, ${fmtRate(topRepo.successes, topRepo.hits)} success)`,
        );
      }

      const topProduct = dossier.productAffinity[0];
      if (topProduct && topProduct.hits >= 3) {
        fragments.push(`top product *${productDisplayName(topProduct.product)}* (${topProduct.hits} jobs)`);
      }

      lines.push(fragments.join('; ') + '.');
      lines.push('');
      lines.push("_miniOG hasn't synthesized a richer profile yet — interact a bit more for the nightly rebuild._");
    }
  }

  // ── Section 2: Things to remember (operator-editable) ────────────────
  lines.push('');
  lines.push('## Things to remember');
  lines.push('_Edit this list directly: add or remove bullets and miniOG will sync._');
  lines.push(PINNED_LIST_BEGIN);
  if (pinnedFacts.length === 0) {
    lines.push('<!-- empty -->');
  } else {
    for (const fact of pinnedFacts) {
      lines.push(`- ${fact.text}`);
    }
  }
  lines.push(PINNED_LIST_END);

  // ── Section 3: Recent work ───────────────────────────────────────────
  lines.push('');
  lines.push('## Recent work');
  if (memories.length === 0) {
    lines.push('No tracked interactions yet.');
  } else {
    for (const m of memories) {
      const date = (m.createdAt ?? '').slice(0, 10);
      const wf = m.workflow ?? 'WORK';
      const status = m.status ?? '?';
      const repoBit = m.repo ? ` ${m.repo}` : '';
      const productBit = m.product ? ` · ${productDisplayName(m.product)}` : '';
      const prBit = m.prUrl ? ` · ${m.prUrl}` : '';
      lines.push(`- **${date}** ${wf} ${status}${repoBit}${productBit} — ${m.summary}${prBit}`);
    }
  }

  return lines.join('\n');
}

/**
 * Pull the bulleted list inside the miniog:pinned-begin / miniog:pinned-end
 * markers from a user note. Returns the array of bullet text values (without
 * the leading `- ` marker), or null if the markers aren't found.
 *
 * This is the read-side helper the watcher uses to diff against
 * `user_pinned_facts`. Operator edits to this list — adding or removing
 * bullets — are mirrored back to the DB.
 */
export function parsePinnedListFromAutoBody(autoBody: string): string[] | null {
  const beginIdx = autoBody.indexOf(PINNED_LIST_BEGIN);
  const endIdx = autoBody.indexOf(PINNED_LIST_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return null;
  const slice = autoBody.slice(beginIdx + PINNED_LIST_BEGIN.length, endIdx);
  const out: string[] = [];
  for (const rawLine of slice.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('<!--')) continue;
    const match = line.match(/^[-*]\s+(.+?)\s*$/);
    if (match) out.push(match[1]);
  }
  return out;
}

const USER_OPERATOR_TRAILER = [
  '## My notes',
  '',
  '<!-- Anything outside the miniog:auto block is preserved across renders.',
  '     Add freeform notes here, or set fields the watcher recognizes:',
  '     Role: <pm|dev|designer|ops>',
  '     Notes: <one-liner kept in user_dossiers.notes> -->',
  '',
].join('\n');

export function renderUserNote(params: {
  dossier: UserDossier;
  pinnedFacts?: ReadonlyArray<PinnedFactRow>;
  memories?: ReadonlyArray<UserMemoryRow>;
  prior?: string;
  now?: Date;
}): string {
  const { dossier, pinnedFacts = [], memories = [], prior, now = new Date() } = params;
  return composeFile({
    frontmatter: {
      miniog_kind: 'user',
      miniog_user_id: dossier.profile?.userId,
      miniog_rendered_at: now.toISOString(),
    },
    autoBody: renderUserAutoBody({ dossier, pinnedFacts, memories }),
    prior,
    defaultOperatorTrailer: USER_OPERATOR_TRAILER,
  });
}

export interface ProjectSummary {
  repo: string;
  topUsers: Array<{ userId: string; displayName?: string; hits: number; successes: number; failures: number }>;
  totalHits: number;
  totalSuccesses: number;
  totalFailures: number;
}

export function renderProjectAutoBody(summary: ProjectSummary): string {
  const lines: string[] = [];
  lines.push(`## Activity for \`${summary.repo}\``);
  lines.push(
    `- **Total jobs**: ${summary.totalHits} (${summary.totalSuccesses} success, ${summary.totalFailures} failed)`,
  );
  lines.push('');
  lines.push('## Top contributors');
  if (summary.topUsers.length === 0) {
    lines.push('No data yet.');
  } else {
    lines.push('| User | Jobs | Success | Fail |');
    lines.push('|---|---:|---:|---:|');
    for (const u of summary.topUsers) {
      const name = u.displayName ?? u.userId;
      lines.push(
        `| ${name} (\`${u.userId}\`) | ${u.hits} | ${u.successes} (${fmtRate(u.successes, u.hits)}) | ${u.failures} |`,
      );
    }
  }
  return lines.join('\n');
}

export function renderProjectNote(params: { summary: ProjectSummary; prior?: string; now?: Date }): string {
  const { summary, prior, now = new Date() } = params;
  return composeFile({
    frontmatter: {
      miniog_kind: 'project',
      miniog_repo: summary.repo,
      miniog_rendered_at: now.toISOString(),
    },
    autoBody: renderProjectAutoBody(summary),
    prior,
  });
}

export interface DailySummary {
  date: string;
  totalJobs: number;
  successes: number;
  failures: number;
  byIntent: Array<{ intent: string; count: number }>;
}

export function renderDailyAutoBody(summary: DailySummary): string {
  const lines: string[] = [];
  lines.push(`## ${summary.date}`);
  lines.push(`- **Total jobs**: ${summary.totalJobs} (${summary.successes} success, ${summary.failures} failed)`);
  if (summary.byIntent.length > 0) {
    lines.push('');
    lines.push('## By intent');
    for (const row of summary.byIntent) {
      lines.push(`- ${row.intent}: ${row.count}`);
    }
  }
  return lines.join('\n');
}

export function renderDailyNote(params: { summary: DailySummary; prior?: string; now?: Date }): string {
  const { summary, prior, now = new Date() } = params;
  return composeFile({
    frontmatter: {
      miniog_kind: 'daily',
      miniog_date: summary.date,
      miniog_rendered_at: now.toISOString(),
    },
    autoBody: renderDailyAutoBody(summary),
    prior,
  });
}
