import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logging/logger.js';
import type { JobStore } from '../state/jobStore.js';
import type { DossierStore } from '../state/dossierStore.js';
import { renderUserNote } from './vaultRenderer.js';
import { slugify, userNotePath } from './vaultPaths.js';

const FLUSH_INTERVAL_MS = 30_000;

// Note: we deliberately do *not* suppress watcher events for self-writes.
// `parseOperatorEdits` only matches `Role:` / `Notes:` outside the auto
// block; the renderer never emits those tokens in operator-editable regions,
// so writer-initiated change events parse to no-ops. `adminEdit` is also
// idempotent under repeated identical edits, so any residual ping-pong
// converges in one cycle.

type DirtyKey = { kind: 'user'; userId: string } | { kind: 'project'; repo: string } | { kind: 'daily'; date: string };

interface VaultWriterRuntime {
  enabled: boolean;
  vaultRoot: string | null;
  store: JobStore;
  dossierStore: DossierStore;
  dirty: Map<string, DirtyKey>;
  timer: NodeJS.Timeout | null;
  flushing: boolean;
}

let runtime: VaultWriterRuntime | null = null;

export interface VaultWriterConfig {
  vaultPath?: string | null;
  enabled: boolean;
  store: JobStore;
}

/**
 * Initialize the vault writer. Idempotent — safe to call repeatedly when
 * settings change. When `enabled` flips off, the existing dirty queue is
 * cleared and the interval stops; subsequent scheduleVaultRender calls early
 * return until enabled again.
 */
export function configureVaultWriter(config: VaultWriterConfig): void {
  const trimmed = config.vaultPath?.trim() ?? '';
  const enabled = config.enabled && trimmed.length > 0;

  if (runtime) {
    runtime.enabled = enabled;
    runtime.vaultRoot = enabled ? trimmed : null;
    if (!enabled) {
      runtime.dirty.clear();
      stopTimer(runtime);
    }
    return;
  }

  runtime = {
    enabled,
    vaultRoot: enabled ? trimmed : null,
    store: config.store,
    dossierStore: config.store.dossierStore(),
    dirty: new Map(),
    timer: null,
    flushing: false,
  };
}

export function shutdownVaultWriter(): void {
  if (!runtime) return;
  stopTimer(runtime);
  runtime.dirty.clear();
}

function stopTimer(rt: VaultWriterRuntime): void {
  if (rt.timer) {
    clearInterval(rt.timer);
    rt.timer = null;
  }
}

function ensureTimer(rt: VaultWriterRuntime): void {
  if (rt.timer) return;
  rt.timer = setInterval(() => {
    void flushVault().catch(err => logger.warn({ err: String(err) }, 'vault flush failed'));
  }, FLUSH_INTERVAL_MS);
  // Don't keep the Node process alive for the vault writer alone.
  if (typeof rt.timer.unref === 'function') rt.timer.unref();
}

function dirtyKeyString(key: DirtyKey): string {
  switch (key.kind) {
    case 'user':
      return `user:${key.userId}`;
    case 'project':
      return `project:${key.repo}`;
    case 'daily':
      return `daily:${key.date}`;
  }
}

export function scheduleVaultRender(key: DirtyKey): void {
  if (!runtime || !runtime.enabled) return;
  runtime.dirty.set(dirtyKeyString(key), key);
  ensureTimer(runtime);
}

async function readPriorContent(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Strip the `miniog_rendered_at:` frontmatter line so that two otherwise
 * identical renders (which only differ in their stamp) compare equal. This
 * keeps Obsidian mtimes stable when the underlying dossier hasn't changed.
 */
function normalizeForComparison(content: string): string {
  return content.replace(/^miniog_rendered_at:.*$/m, 'miniog_rendered_at:<elided>');
}

/**
 * Write content to filePath atomically, but skip the write entirely when the
 * existing file already has the same content (ignoring the rendered_at
 * timestamp). Returns true when a write happened, false otherwise.
 */
export async function atomicWriteIfChanged(filePath: string, content: string): Promise<boolean> {
  const existing = await readPriorContent(filePath);
  if (existing !== undefined && normalizeForComparison(existing) === normalizeForComparison(content)) {
    return false;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
  return true;
}

async function renderUserKey(rt: VaultWriterRuntime, userId: string): Promise<void> {
  if (!rt.vaultRoot) return;
  const dossier = rt.dossierStore.getDossier(userId);
  const pinnedFacts = rt.dossierStore.listPinnedFacts(userId);
  // Cap recent work in the file at 30 entries; the file is meant for human
  // browsing and the recall block already injects 8 into the prompt.
  const memories = rt.dossierStore.recentMemoriesForUser(userId, 30);
  const slug = slugify(dossier.profile?.displayName ?? dossier.profile?.realName ?? userId);
  const filePath = userNotePath(rt.vaultRoot, slug);
  const prior = await readPriorContent(filePath);
  const body = renderUserNote({ dossier, pinnedFacts, memories, prior });
  const wrote = await atomicWriteIfChanged(filePath, body);
  if (wrote) {
    logger.info({ userId, filePath }, 'vault user note written');
  }
}

/**
 * Drain the dirty queue. Exported for tests; production calls happen on a
 * setInterval owned by configureVaultWriter.
 */
export async function flushVault(): Promise<void> {
  if (!runtime || !runtime.enabled || !runtime.vaultRoot) return;
  if (runtime.flushing) return;
  if (runtime.dirty.size === 0) {
    stopTimer(runtime);
    return;
  }
  const todo = [...runtime.dirty.values()];
  runtime.dirty.clear();
  runtime.flushing = true;
  try {
    for (const key of todo) {
      try {
        if (key.kind === 'user') {
          await renderUserKey(runtime, key.userId);
        }
        // project and daily renders are scaffolded but not yet wired to data
        // sources beyond what the dossier already exposes; fill them in when
        // we add per-repo and per-day query helpers.
      } catch (err) {
        logger.warn({ err: String(err), key }, 'vault render failed for entry');
      }
    }
  } finally {
    runtime.flushing = false;
  }
  if (runtime.dirty.size === 0) {
    stopTimer(runtime);
  }
}

/** Test-only helper. Resets module state so isolated tests don't leak. */
export function __resetVaultWriterForTests(): void {
  runtime = null;
}
