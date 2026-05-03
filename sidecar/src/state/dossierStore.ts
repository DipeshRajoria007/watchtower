import type Database from 'better-sqlite3';
import type { DossierForgetField, DossierRole, PersonalityMode } from '../types/contracts.js';
import {
  computeActiveHours,
  computeFailureFingerprint,
  computeIntentMix,
  computeProjectAffinity,
  computeResponseStyle,
  rollupWindowStart,
  type LearningSignalRow,
} from './dossierBuilder.js';
import { scheduleVaultRender } from '../vault/vaultWriter.js';

export interface DossierProfile {
  userId: string;
  displayName?: string;
  realName?: string;
  tz?: string;
  email?: string;
  role?: DossierRole;
  notes?: string;
  source?: string;
  firstSeenAt: string;
  updatedAt: string;
}

export interface DossierAffinityRow {
  repo: string;
  hits: number;
  successes: number;
  failures: number;
  lastUsedAt?: string;
  computedAt: string;
}

export interface UserDossier {
  profile: DossierProfile | null;
  affinity: DossierAffinityRow[];
  metrics: Record<string, unknown>;
  tone: PersonalityMode;
  toneSource?: string;
}

export interface DossierSummary {
  userId: string;
  displayName?: string;
  realName?: string;
  role?: DossierRole;
  tz?: string;
  updatedAt: string;
}

const ROLES: ReadonlySet<string> = new Set(['pm', 'dev', 'designer', 'ops']);
const FORGET_FIELDS: ReadonlySet<string> = new Set(['role', 'tone', 'notes', 'project_affinity', 'metrics', 'all']);

export function isDossierRole(value: string): value is DossierRole {
  return ROLES.has(value);
}

export function isDossierForgetField(value: string): value is DossierForgetField {
  return FORGET_FIELDS.has(value);
}

class TtlLru<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();
  constructor(
    private maxSize = 256,
    private ttlMs = 5 * 60 * 1000,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  invalidate(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

export interface DossierStore {
  firstSeen(input: { userId: string; displayName?: string; realName?: string; tz?: string; email?: string }): void;
  getDossier(userId: string): UserDossier;
  setRole(userId: string, role: DossierRole): void;
  setTone(userId: string, mode: PersonalityMode, source: string): void;
  forgetField(userId: string, field: DossierForgetField): void;
  adminEdit(input: { userId: string; role?: DossierRole | null; notes?: string | null }): void;
  listDossiers(): DossierSummary[];
  invalidate(userId: string): void;
}

const PROFILE_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Rollups recompute when (a) any new signal exists since the last rollup, or
 * (b) the last rollup is older than this many ms. The TTL guard catches
 * dossiers that have stale rollups but no recent signals — so a new repo
 * affinity from a colleague's history doesn't outlive its 30-day window.
 */
const ROLLUP_TTL_MS = 24 * 60 * 60 * 1000;

export function createDossierStore(db: Database.Database): DossierStore {
  const cache = new TtlLru<UserDossier>();

  const insertProfile = db.prepare(
    `INSERT INTO user_dossiers(
       user_id, display_name, real_name, tz, email, role, notes, source, first_seen_at, updated_at
     ) VALUES(@userId, @displayName, @realName, @tz, @email, NULL, NULL, 'auto', @now, @now)
     ON CONFLICT(user_id) DO NOTHING`,
  );

  const refreshProfile = db.prepare(
    `UPDATE user_dossiers
     SET display_name = COALESCE(@displayName, display_name),
         real_name = COALESCE(@realName, real_name),
         tz = COALESCE(@tz, tz),
         email = COALESCE(@email, email),
         updated_at = @now
     WHERE user_id = @userId AND updated_at < @staleBefore`,
  );

  const selectProfile = db.prepare(
    `SELECT user_id AS userId,
            display_name AS displayName,
            real_name AS realName,
            tz, email, role, notes, source,
            first_seen_at AS firstSeenAt,
            updated_at AS updatedAt
     FROM user_dossiers
     WHERE user_id = ?
     LIMIT 1`,
  );

  const selectAffinity = db.prepare(
    `SELECT repo,
            hits,
            successes,
            failures,
            last_used_at AS lastUsedAt,
            computed_at AS computedAt
     FROM user_project_affinity
     WHERE user_id = ?
     ORDER BY hits DESC, successes DESC`,
  );

  const selectMetrics = db.prepare(
    `SELECT metric_key AS metricKey, metric_value AS metricValue
     FROM user_metrics
     WHERE user_id = ?`,
  );

  const selectTone = db.prepare(
    `SELECT mode, source
     FROM personality_profiles
     WHERE scope = 'user' AND scope_id = ?
     LIMIT 1`,
  );

  const upsertRoleStmt = db.prepare(
    `INSERT INTO user_dossiers(
       user_id, display_name, real_name, tz, email, role, notes, source, first_seen_at, updated_at
     ) VALUES(@userId, NULL, NULL, NULL, NULL, @role, NULL, 'set-role', @now, @now)
     ON CONFLICT(user_id) DO UPDATE SET
       role = excluded.role,
       source = 'set-role',
       updated_at = excluded.updated_at`,
  );

  const setToneStmt = db.prepare(
    `INSERT INTO personality_profiles(scope, scope_id, mode, source, updated_at)
     VALUES('user', @userId, @mode, @source, @now)
     ON CONFLICT(scope, scope_id) DO UPDATE SET
       mode = excluded.mode,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  );

  const adminEditStmt = db.prepare(
    `INSERT INTO user_dossiers(
       user_id, display_name, real_name, tz, email, role, notes, source, first_seen_at, updated_at
     ) VALUES(@userId, NULL, NULL, NULL, NULL, @role, @notes, 'admin-edit', @now, @now)
     ON CONFLICT(user_id) DO UPDATE SET
       role = COALESCE(excluded.role, user_dossiers.role),
       notes = COALESCE(excluded.notes, user_dossiers.notes),
       source = 'admin-edit',
       updated_at = excluded.updated_at`,
  );

  const clearRoleStmt = db.prepare(
    `UPDATE user_dossiers SET role = NULL, source = 'forget', updated_at = @now WHERE user_id = @userId`,
  );
  const clearNotesStmt = db.prepare(
    `UPDATE user_dossiers SET notes = NULL, source = 'forget', updated_at = @now WHERE user_id = @userId`,
  );
  const deleteToneStmt = db.prepare(`DELETE FROM personality_profiles WHERE scope = 'user' AND scope_id = ?`);
  const deleteAffinityStmt = db.prepare(`DELETE FROM user_project_affinity WHERE user_id = ?`);
  const deleteMetricsStmt = db.prepare(`DELETE FROM user_metrics WHERE user_id = ?`);
  const deleteProfileStmt = db.prepare(`DELETE FROM user_dossiers WHERE user_id = ?`);

  const listStmt = db.prepare(
    `SELECT user_id AS userId,
            display_name AS displayName,
            real_name AS realName,
            role, tz,
            updated_at AS updatedAt
     FROM user_dossiers
     ORDER BY updated_at DESC
     LIMIT 500`,
  );

  // --- Lazy rollup support (Phase 1) -------------------------------------

  const probeNewSignal = db.prepare(
    `SELECT 1 AS hit
     FROM learning_signals
     WHERE user_id = ? AND created_at > ?
     LIMIT 1`,
  );

  const selectSignalsWindow = db.prepare(
    `SELECT job_id AS jobId,
            channel_id AS channelId,
            user_id AS userId,
            workflow,
            intent,
            status,
            correction_applied AS correctionApplied,
            personality_mode AS personalityMode,
            error_kind AS errorKind,
            repo,
            created_at AS createdAt
     FROM learning_signals
     WHERE user_id = ? AND created_at >= ?
     ORDER BY created_at DESC`,
  );

  const lastSignalAt = db.prepare(
    `SELECT MAX(created_at) AS lastAt
     FROM learning_signals
     WHERE user_id = ?`,
  );

  const upsertAffinityStmt = db.prepare(
    `INSERT INTO user_project_affinity(
       user_id, repo, hits, successes, failures, last_used_at, computed_at
     ) VALUES(@userId, @repo, @hits, @successes, @failures, @lastUsedAt, @computedAt)
     ON CONFLICT(user_id, repo) DO UPDATE SET
       hits = excluded.hits,
       successes = excluded.successes,
       failures = excluded.failures,
       last_used_at = excluded.last_used_at,
       computed_at = excluded.computed_at`,
  );

  /** Drop affinity rows for repos that no longer appear in the 30-day window. */
  const deleteStaleAffinityStmt = db.prepare(
    `DELETE FROM user_project_affinity WHERE user_id = @userId AND computed_at < @cutoff`,
  );

  const upsertMetricStmt = db.prepare(
    `INSERT INTO user_metrics(user_id, metric_key, metric_value, computed_at)
     VALUES(@userId, @metricKey, @metricValue, @computedAt)
     ON CONFLICT(user_id, metric_key) DO UPDATE SET
       metric_value = excluded.metric_value,
       computed_at = excluded.computed_at`,
  );

  const minComputedAtStmt = db.prepare(
    `SELECT MIN(computed_at) AS minAt FROM (
       SELECT computed_at FROM user_project_affinity WHERE user_id = ?
       UNION ALL
       SELECT computed_at FROM user_metrics WHERE user_id = ?
     )`,
  );

  function rollupUserNow(userId: string, now: Date): void {
    const windowStart = rollupWindowStart(now).toISOString();
    const computedAt = now.toISOString();

    const rows = selectSignalsWindow.all(userId, windowStart) as LearningSignalRow[];

    const affinity = computeProjectAffinity(rows);
    const failureFingerprint = computeFailureFingerprint(rows, now);
    const intentMix = computeIntentMix(rows);
    const responseStyle = computeResponseStyle(rows);
    const activeHours = computeActiveHours(rows);

    // Wipe rows older than this run, then UPSERT current ones. Together this
    // ensures repos that fell out of the window are removed. SQLite WAL +
    // single-statement writes are atomic; a partial failure here is harmless
    // because the next getDossier call will recompute.
    deleteStaleAffinityStmt.run({ userId, cutoff: computedAt });
    for (const row of affinity) {
      upsertAffinityStmt.run({
        userId,
        repo: row.repo,
        hits: row.hits,
        successes: row.successes,
        failures: row.failures,
        lastUsedAt: row.lastUsedAt ?? null,
        computedAt,
      });
    }

    for (const [metricKey, value] of [
      ['failure_fingerprint', failureFingerprint],
      ['intent_mix', intentMix],
      ['response_style', responseStyle],
      ['active_hours', activeHours],
    ] as const) {
      upsertMetricStmt.run({
        userId,
        metricKey,
        metricValue: JSON.stringify(value),
        computedAt,
      });
    }

    // Honor operator-set tone: only write a passive-learn tone if the user
    // has no existing personality_profiles row, or the existing row was
    // itself written by passive learning. Operator sources (set-role,
    // admin-edit) are never overwritten.
    if (responseStyle.suggestedMode !== 'normal') {
      const existing = selectTone.get(userId) as { source?: string } | undefined;
      const existingSource = existing?.source ?? null;
      const isOperatorSet = existingSource && existingSource !== 'passive-learn';
      if (!isOperatorSet) {
        setToneStmt.run({
          userId,
          mode: responseStyle.suggestedMode,
          source: 'passive-learn',
          now: computedAt,
        });
      }
    }
  }

  function shouldRecompute(userId: string, now: Date): boolean {
    const minRow = minComputedAtStmt.get(userId, userId) as { minAt?: string | null } | undefined;
    const lastComputed = minRow?.minAt ?? null;
    if (!lastComputed) {
      // No rollups yet. Recompute only if there's at least one signal to feed
      // them — avoids writing empty metric rows for unknown users.
      const last = lastSignalAt.get(userId) as { lastAt?: string | null } | undefined;
      return Boolean(last?.lastAt);
    }
    if (now.getTime() - new Date(lastComputed).getTime() >= ROLLUP_TTL_MS) return true;
    const probe = probeNewSignal.get(userId, lastComputed) as { hit?: number } | undefined;
    return Boolean(probe?.hit);
  }

  function readDossier(userId: string): UserDossier {
    const profileRow = selectProfile.get(userId) as DossierProfile | undefined;
    const affinityRows = selectAffinity.all(userId) as DossierAffinityRow[];
    const metricRows = selectMetrics.all(userId) as Array<{ metricKey: string; metricValue: string }>;
    const toneRow = selectTone.get(userId) as { mode?: string; source?: string } | undefined;

    const metrics: Record<string, unknown> = {};
    for (const row of metricRows) {
      try {
        metrics[row.metricKey] = JSON.parse(row.metricValue);
      } catch {
        metrics[row.metricKey] = row.metricValue;
      }
    }

    const tone: PersonalityMode =
      toneRow?.mode === 'terse' || toneRow?.mode === 'technical' || toneRow?.mode === 'casual'
        ? toneRow.mode
        : 'normal';

    return {
      profile: profileRow ?? null,
      affinity: affinityRows,
      metrics,
      tone,
      toneSource: toneRow?.source,
    };
  }

  return {
    firstSeen(input) {
      const now = new Date().toISOString();
      const params = {
        userId: input.userId,
        displayName: input.displayName ?? null,
        realName: input.realName ?? null,
        tz: input.tz ?? null,
        email: input.email ?? null,
        now,
      };
      insertProfile.run(params);
      const staleBefore = new Date(Date.now() - PROFILE_REFRESH_MS).toISOString();
      refreshProfile.run({ ...params, staleBefore });
      cache.invalidate(input.userId);
      scheduleVaultRender({ kind: 'user', userId: input.userId });
    },

    getDossier(userId) {
      const cached = cache.get(userId);
      if (cached) return cached;
      const now = new Date();
      if (shouldRecompute(userId, now)) {
        try {
          rollupUserNow(userId, now);
        } catch {
          // Recompute failures fall through to whatever rollup data is on disk;
          // do not block the read. The next call will try again.
        }
      }
      const dossier = readDossier(userId);
      cache.set(userId, dossier);
      return dossier;
    },

    setRole(userId, role) {
      const now = new Date().toISOString();
      upsertRoleStmt.run({ userId, role, now });
      cache.invalidate(userId);
      scheduleVaultRender({ kind: 'user', userId });
    },

    setTone(userId, mode, source) {
      const now = new Date().toISOString();
      setToneStmt.run({ userId, mode, source, now });
      cache.invalidate(userId);
      scheduleVaultRender({ kind: 'user', userId });
    },

    forgetField(userId, field) {
      const now = new Date().toISOString();
      switch (field) {
        case 'role':
          clearRoleStmt.run({ userId, now });
          break;
        case 'notes':
          clearNotesStmt.run({ userId, now });
          break;
        case 'tone':
          deleteToneStmt.run(userId);
          break;
        case 'project_affinity':
          deleteAffinityStmt.run(userId);
          break;
        case 'metrics':
          deleteMetricsStmt.run(userId);
          break;
        case 'all':
          deleteToneStmt.run(userId);
          deleteAffinityStmt.run(userId);
          deleteMetricsStmt.run(userId);
          deleteProfileStmt.run(userId);
          break;
      }
      cache.invalidate(userId);
      scheduleVaultRender({ kind: 'user', userId });
    },

    adminEdit(input) {
      const now = new Date().toISOString();
      adminEditStmt.run({
        userId: input.userId,
        role: input.role ?? null,
        notes: input.notes ?? null,
        now,
      });
      cache.invalidate(input.userId);
      scheduleVaultRender({ kind: 'user', userId: input.userId });
    },

    listDossiers() {
      return listStmt.all() as DossierSummary[];
    },

    invalidate(userId) {
      cache.invalidate(userId);
    },
  };
}

export function formatDossierForPrompt(dossier: UserDossier): string {
  const lines: string[] = [];
  const profile = dossier.profile;
  const name = profile?.displayName ?? profile?.realName ?? profile?.userId ?? 'unknown user';
  const role = profile?.role ? ` (${profile.role})` : '';
  const tz = profile?.tz ? ` — ${profile.tz}` : '';
  lines.push(`User: ${name}${role}${tz}`);

  const topRepo = dossier.affinity[0];
  if (topRepo && topRepo.hits > 0) {
    const rate = Math.round((100 * topRepo.successes) / Math.max(1, topRepo.hits));
    lines.push(`Primary repo: ${topRepo.repo} (${topRepo.hits} jobs, ${rate}% success)`);
  }

  const intentMix = dossier.metrics['intent_mix'];
  if (intentMix && typeof intentMix === 'object') {
    const entries = Object.entries(intentMix as Record<string, number>)
      .filter(([, v]) => typeof v === 'number')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}(${v})`);
    if (entries.length > 0) lines.push(`Typical intents: ${entries.join(', ')}`);
  }

  if (dossier.tone !== 'normal') lines.push(`Preferred tone: ${dossier.tone}`);

  const fp = dossier.metrics['failure_fingerprint'] as { topErrorKinds?: Array<{ kind: string }> } | undefined;
  if (fp?.topErrorKinds?.length) {
    const kinds = fp.topErrorKinds
      .slice(0, 2)
      .map(e => e.kind)
      .join(', ');
    if (kinds) lines.push(`Common failure modes: ${kinds}`);
  }

  return lines.map(line => (line.length > 200 ? line.slice(0, 197) + '...' : line)).join('\n');
}

/**
 * Translate internal WorkflowIntent values into something a human can parse
 * at a glance. Returns null for intents that aren't worth surfacing
 * (chat, silent routes, the dossier command itself, unrouted noise) so
 * those don't pollute the "Mostly:" hint.
 *
 * If a new WorkflowIntent value is added without a translation here, the
 * humane formatter silently skips it — that's a safer default than
 * rendering a raw enum string back to the user.
 */
function intentToHumanLabel(intent: string): string | null {
  switch (intent) {
    case 'IMPLEMENTATION':
      return 'code changes';
    case 'INVESTIGATION':
      return 'investigations';
    case 'INFORMATIONAL':
      return 'questions';
    case 'PR_REVIEW':
      return 'PR reviews';
    case 'OWNER_AUTOPILOT':
      return 'general help';
    case 'DEV_ASSIST':
      return '`wt` commands';
    case 'DEPLOY':
      return 'deploys';
    default:
      return null;
  }
}

/**
 * Friendly Slack message body for `<@miniog> whoami`. Returns null when there
 * is literally nothing useful to say (no profile, no rolled-up metrics) so
 * the caller can render a cold-start message instead.
 *
 * This is the user-facing surface — it deliberately does NOT leak internal
 * taxonomy (WorkflowIntent enum names, error_kind codes). For LLM-facing
 * surfaces, use `formatDossierForPrompt` instead.
 */
export function formatDossierForHuman(dossier: UserDossier): string | null {
  const profile = dossier.profile;
  const intentMix = dossier.metrics['intent_mix'] as Record<string, number> | undefined;
  const hasMetrics = Boolean(intentMix && Object.keys(intentMix).length > 0);
  if (!profile && !hasMetrics) return null;

  const lines: string[] = ["Here's what I know about you:"];
  const name = profile?.displayName ?? profile?.realName ?? profile?.userId ?? 'someone I haven’t met yet';
  lines.push(`• *Name*: ${name}`);

  if (profile?.tz) {
    lines.push(`• *Timezone*: ${profile.tz}`);
  }

  if (profile?.role) {
    lines.push(`• *Role*: ${profile.role}`);
  } else {
    lines.push('• *Role*: not set — try `set-role pm` (or dev/designer/ops)');
  }

  // Tone is only worth surfacing when the operator explicitly set it. Passive
  // learning derives a tone but stays silent — surfacing it would feel like
  // miniOG inferring something behind the user's back.
  if (dossier.tone !== 'normal' && (dossier.toneSource === 'set-role' || dossier.toneSource === 'admin-edit')) {
    lines.push(`• *Tone*: ${dossier.tone} (you set this)`);
  }

  // Activity volume — sum the intent counts that we actually surface to the
  // user (skip CONVERSATIONAL/NONE/UNKNOWN/MINIOG_DOSSIER) so the number
  // matches the "Mostly:" denominator below.
  let totalRelevant = 0;
  let dominantIntent: string | null = null;
  let dominantCount = 0;
  if (intentMix) {
    for (const [intent, count] of Object.entries(intentMix)) {
      if (typeof count !== 'number' || count <= 0) continue;
      if (intentToHumanLabel(intent) === null) continue;
      totalRelevant += count;
      if (count > dominantCount) {
        dominantCount = count;
        dominantIntent = intent;
      }
    }
  }
  if (totalRelevant > 0) {
    lines.push(`• *Activity*: ${totalRelevant} jobs in the last month`);
    if (dominantIntent && dominantCount / totalRelevant >= 0.3) {
      const label = intentToHumanLabel(dominantIntent);
      if (label) lines.push(`• *Mostly*: ${label}`);
    }
  }

  const topRepo = dossier.affinity[0];
  if (topRepo && topRepo.hits >= 3) {
    const rate = Math.round((100 * topRepo.successes) / Math.max(1, topRepo.hits));
    lines.push(`• *Most active in*: \`${topRepo.repo}\` (${topRepo.hits} jobs, ${rate}% success)`);
  }

  const fp = dossier.metrics['failure_fingerprint'] as { failureRate7d?: number; samples?: number } | undefined;
  if (fp && (fp.samples ?? 0) >= 5 && (fp.failureRate7d ?? 0) > 0.3) {
    const pct = Math.round((fp.failureRate7d ?? 0) * 100);
    lines.push(`• *Recent snags*: ${pct}% failure over ${fp.samples} jobs in the last week.`);
  }

  lines.push('');
  lines.push('> Wipe with `forget all confirm`.');
  return lines.join('\n');
}

export const __test__ = { TtlLru };
