import type { UserDossier } from '../state/dossierStore.js';

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

/** Markdown body for a single user's auto block. */
export function renderUserAutoBody(dossier: UserDossier): string {
  const profile = dossier.profile;
  const lines: string[] = [];

  lines.push('## Profile');
  if (!profile) {
    lines.push('No identity captured yet.');
  } else {
    const name = profile.displayName ?? profile.realName ?? profile.userId;
    lines.push(`- **Name**: ${name}`);
    lines.push(`- **User ID**: \`${profile.userId}\``);
    if (profile.role) lines.push(`- **Role**: ${profile.role}`);
    if (profile.tz) lines.push(`- **Timezone**: ${profile.tz}`);
    if (profile.email) lines.push(`- **Email**: ${profile.email}`);
    lines.push(`- **First seen**: ${profile.firstSeenAt}`);
    lines.push(`- **Updated**: ${profile.updatedAt}`);
  }

  if (dossier.tone !== 'normal') {
    lines.push('');
    lines.push('## Tone');
    lines.push(`- **Mode**: ${dossier.tone}`);
    if (dossier.toneSource) lines.push(`- **Source**: ${dossier.toneSource}`);
  }

  lines.push('');
  lines.push('## Project affinity');
  if (dossier.affinity.length === 0) {
    lines.push('No data yet.');
  } else {
    lines.push('| Repo | Hits | Success | Fail | Last used |');
    lines.push('|---|---:|---:|---:|---|');
    for (const row of dossier.affinity) {
      lines.push(
        `| ${row.repo} | ${row.hits} | ${row.successes} (${fmtRate(row.successes, row.hits)}) | ${row.failures} | ${row.lastUsedAt ?? '—'} |`,
      );
    }
  }

  const intentMix = dossier.metrics['intent_mix'] as Record<string, number> | undefined;
  if (intentMix && Object.keys(intentMix).length > 0) {
    lines.push('');
    lines.push('## Typical intents');
    const sorted = Object.entries(intentMix).sort((a, b) => b[1] - a[1]);
    for (const [intent, count] of sorted) {
      lines.push(`- ${intent}: ${count}`);
    }
  }

  const fp = dossier.metrics['failure_fingerprint'] as
    | { topErrorKinds?: Array<{ kind: string; count: number }>; failureRate7d?: number; samples?: number }
    | undefined;
  if (fp && (fp.topErrorKinds?.length || typeof fp.failureRate7d === 'number')) {
    lines.push('');
    lines.push('## Failure fingerprint');
    if (typeof fp.failureRate7d === 'number' && (fp.samples ?? 0) > 0) {
      lines.push(`- **7-day failure rate**: ${Math.round(100 * fp.failureRate7d)}% over ${fp.samples} jobs`);
    }
    if (fp.topErrorKinds?.length) {
      for (const ek of fp.topErrorKinds) {
        lines.push(`- ${ek.kind}: ${ek.count}`);
      }
    }
  }

  if (profile?.notes) {
    lines.push('');
    lines.push('## Operator notes (from Tauri)');
    lines.push(profile.notes);
  }

  return lines.join('\n');
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

export function renderUserNote(params: { dossier: UserDossier; prior?: string; now?: Date }): string {
  const { dossier, prior, now = new Date() } = params;
  return composeFile({
    frontmatter: {
      miniog_kind: 'user',
      miniog_user_id: dossier.profile?.userId,
      miniog_rendered_at: now.toISOString(),
    },
    autoBody: renderUserAutoBody(dossier),
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
