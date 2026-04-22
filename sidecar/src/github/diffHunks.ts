/**
 * Unified-diff hunk parser for PR-review pre-validation.
 *
 * Given the raw `.diff` text GitHub returns for a pull request, produce a map
 * of `file path -> set of right-side (new file) line numbers` present in the
 * diff hunks. Callers use this to pre-filter inline review comments so we
 * don't hand GitHub a batch that it 422s for having any single entry outside
 * a hunk (which would then drop the entire batch).
 *
 * Fail-closed: lines that aren't present in the index are treated as invalid.
 * Truncated diffs (our fetcher caps at 100 K chars) just yield a partial
 * index — anything past the cutoff is considered invalid, which is the safe
 * direction.
 */

export type HunkIndex = Map<string, Set<number>>;

const HUNK_HEADER_RE = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

export function parseDiffHunks(rawDiff: string): HunkIndex {
  const index: HunkIndex = new Map();
  if (!rawDiff) return index;

  const lines = rawDiff.split('\n');

  let currentFile: string | undefined;
  let currentSet: Set<number> | undefined;
  let newLineCursor = 0;
  let inHunk = false;

  for (const raw of lines) {
    // File header — we only trust the `+++ b/<path>` line for the right-side
    // path. Ignore `diff --git` (which encodes both sides) and `--- a/<path>`
    // (left side), because renames, mode-only changes, and binary markers can
    // make the `diff --git` header lie.
    if (raw.startsWith('+++ ')) {
      inHunk = false;
      const rest = raw.slice(4).trim();
      if (rest === '/dev/null') {
        // Pure deletion — no right-side content to anchor to.
        currentFile = undefined;
        currentSet = undefined;
        continue;
      }
      // Strip optional `b/` prefix; tolerate timestamps GitHub rarely appends.
      const withoutTs = rest.split('\t')[0].trim();
      const path = withoutTs.startsWith('b/') ? withoutTs.slice(2) : withoutTs;
      currentFile = path || undefined;
      if (currentFile) {
        currentSet = index.get(currentFile);
        if (!currentSet) {
          currentSet = new Set<number>();
          index.set(currentFile, currentSet);
        }
      } else {
        currentSet = undefined;
      }
      continue;
    }

    if (raw.startsWith('--- ')) {
      // Left-side path — ignore, we track the right side.
      inHunk = false;
      continue;
    }

    if (raw.startsWith('diff --git')) {
      // Reset until the next `+++` tells us the effective right-side path.
      currentFile = undefined;
      currentSet = undefined;
      inHunk = false;
      continue;
    }

    // Binary / mode-only sections — skip noise until the next file header.
    if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch')) {
      currentFile = undefined;
      currentSet = undefined;
      inHunk = false;
      continue;
    }

    const hunkHeader = HUNK_HEADER_RE.exec(raw);
    if (hunkHeader) {
      newLineCursor = parseInt(hunkHeader[1], 10);
      inHunk = Boolean(currentSet);
      continue;
    }

    if (!inHunk || !currentSet) continue;

    // Within a hunk body:
    //  '+' — added line, belongs to the right side at newLineCursor.
    //  ' ' — context line, present on both sides; counts toward the right.
    //  '-' — removed line, left-only. Do not advance the right cursor.
    //  '\' — "No newline at end of file" marker; skip without moving cursor.
    if (raw.startsWith('+')) {
      currentSet.add(newLineCursor);
      newLineCursor++;
    } else if (raw.startsWith(' ')) {
      currentSet.add(newLineCursor);
      newLineCursor++;
    } else if (raw.startsWith('-')) {
      // no-op on right side
    } else if (raw.startsWith('\\')) {
      // no-op
    } else {
      // A blank or unexpected line ends the hunk; wait for the next `@@` or
      // file header.
      inHunk = false;
    }
  }

  return index;
}

export function isAnchorInDiff(index: HunkIndex, file: string, line: number): boolean {
  if (!file || !Number.isFinite(line) || line <= 0) return false;
  const set = index.get(file);
  return Boolean(set && set.has(line));
}

export function firstChangedLine(index: HunkIndex, file: string): number | undefined {
  const set = index.get(file);
  if (!set || set.size === 0) return undefined;
  let min: number | undefined;
  for (const n of set) {
    if (min === undefined || n < min) min = n;
  }
  return min;
}

export function hasFileInDiff(index: HunkIndex, file: string): boolean {
  const set = index.get(file);
  return Boolean(set && set.size > 0);
}
