import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { logger } from '../logging/logger.js';
import type { JobStore } from '../state/jobStore.js';
import type { DossierRole } from '../types/contracts.js';
import { splitAutoBlock } from './vaultRenderer.js';
import { scheduleVaultRender } from './vaultWriter.js';

const VALID_ROLES: ReadonlySet<DossierRole> = new Set<DossierRole>(['pm', 'dev', 'designer', 'ops']);
const NOTES_MAX_LEN = 2048;

export interface ParsedFrontmatter {
  miniog_kind?: string;
  miniog_user_id?: string;
  miniog_repo?: string;
  miniog_date?: string;
  miniog_rendered_at?: string;
}

export interface OperatorEdits {
  role?: DossierRole | null;
  notes?: string | null;
}

interface VaultWatcherRuntime {
  store: JobStore;
  watcher: FSWatcher;
  vaultRoot: string;
}

let runtime: VaultWatcherRuntime | null = null;

/**
 * Parse the YAML-ish frontmatter at the top of a vault file. We don't pull a
 * full YAML dep — the renderer only emits flat scalar `key: value` lines, so
 * a hand-written parser is plenty.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  const body = raw.slice(3, end).trim();
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key) out[key] = value;
  }
  return out as ParsedFrontmatter;
}

/**
 * Pull `Role:` and `Notes:` from the operator-editable region of a vault
 * markdown file. Returns `undefined` for fields that are missing or invalid;
 * the caller treats undefined as "no change" (vs. `null`, which means
 * "explicitly cleared").
 */
export function parseOperatorEdits(raw: string): OperatorEdits {
  const split = splitAutoBlock(raw);
  // Operator content lives outside the auto block. If markers are absent,
  // treat the whole file as operator content (post-fall-through case from
  // composeFile).
  const operatorContent = split ? `${split.before}\n${split.after}` : raw;

  const edits: OperatorEdits = {};

  const roleMatch = operatorContent.match(/^\s*Role\s*:\s*(.+?)\s*$/im);
  if (roleMatch) {
    const candidate = roleMatch[1].trim().toLowerCase();
    if (candidate === '' || candidate === '<none>' || candidate === '-') {
      edits.role = null;
    } else if (VALID_ROLES.has(candidate as DossierRole)) {
      edits.role = candidate as DossierRole;
    }
    // unrecognized role: leave undefined so we don't clobber the DB row
  }

  const notesMatch = operatorContent.match(/^\s*Notes\s*:(.*)$/im);
  if (notesMatch) {
    const value = notesMatch[1].trim();
    if (!value || value === '<none>') {
      edits.notes = null;
    } else {
      edits.notes = value.slice(0, NOTES_MAX_LEN);
    }
  }

  return edits;
}

async function handleVaultFileChange(rt: VaultWatcherRuntime, filePath: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err: String(err), filePath }, 'vault watcher: failed to read file');
    }
    return;
  }

  const fm = parseFrontmatter(content);
  if (!fm || fm.miniog_kind !== 'user' || !fm.miniog_user_id) {
    logger.debug({ filePath, kind: fm?.miniog_kind }, 'vault watcher: file is not a recognized user note');
    return;
  }

  const edits = parseOperatorEdits(content);
  if (edits.role === undefined && edits.notes === undefined) {
    logger.debug({ filePath, userId: fm.miniog_user_id }, 'vault watcher: no recognized operator edits');
    return;
  }

  try {
    rt.store.dossierStore().adminEdit({
      userId: fm.miniog_user_id,
      role: edits.role,
      notes: edits.notes,
    });
    logger.info(
      { userId: fm.miniog_user_id, role: edits.role, notesLength: edits.notes?.length ?? null },
      'vault watcher: applied operator edit',
    );
  } catch (err) {
    logger.warn({ err: String(err), userId: fm.miniog_user_id }, 'vault watcher: adminEdit failed');
    return;
  }

  // adminEdit already calls scheduleVaultRender; we re-emit defensively in
  // case the writer was misconfigured. No-op when disabled.
  scheduleVaultRender({ kind: 'user', userId: fm.miniog_user_id });
}

export interface VaultWatcherConfig {
  store: JobStore;
  vaultPath?: string | null;
  enabled: boolean;
}

/**
 * Start (or restart) the chokidar watcher. Idempotent — calling with the same
 * path is a no-op; calling with a different path or disabled state stops the
 * existing watcher first.
 */
export async function configureVaultWatcher(config: VaultWatcherConfig): Promise<void> {
  const trimmed = config.vaultPath?.trim() ?? '';
  const enabled = config.enabled && trimmed.length > 0;

  if (runtime && (runtime.vaultRoot !== trimmed || !enabled)) {
    await runtime.watcher.close();
    runtime = null;
  }
  if (!enabled) return;
  if (runtime && runtime.vaultRoot === trimmed) return;

  const usersDir = path.join(trimmed, 'miniog', 'users');
  // Make sure the directory exists before chokidar attaches; chokidar 5 will
  // surface an error rather than wait when the path is missing.
  try {
    await fs.mkdir(usersDir, { recursive: true });
  } catch {
    /* mkdir failures bubble through chokidar's error handler below */
  }
  const watcher = chokidar.watch(usersDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: /(^|[/\\])\.[^/\\]/, // ignore dotfiles and chokidar tmp partials
  });

  runtime = { store: config.store, watcher, vaultRoot: trimmed };

  watcher.on('change', filePath => {
    void handleVaultFileChange(runtime!, filePath);
  });
  watcher.on('add', filePath => {
    void handleVaultFileChange(runtime!, filePath);
  });
  watcher.on('error', err => {
    logger.warn({ err: String(err) }, 'vault watcher: chokidar error');
  });

  // Resolve only after chokidar has finished its initial scan — otherwise
  // tests (and prod startup) could race subsequent file edits before the
  // watcher is actually listening.
  await new Promise<void>(resolve => {
    watcher.once('ready', () => resolve());
  });

  logger.info({ vaultRoot: trimmed }, 'vault watcher: started');
}

export async function shutdownVaultWatcher(): Promise<void> {
  if (!runtime) return;
  await runtime.watcher.close();
  runtime = null;
}

/** Test-only helper. */
export function __resetVaultWatcherForTests(): void {
  runtime = null;
}
