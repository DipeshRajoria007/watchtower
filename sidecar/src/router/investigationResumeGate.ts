import type { InvestigationFindings } from '../state/investigationStore.js';

/**
 * Reactions that confirm a pending investigation. ✅ is the documented one
 * in the new investigation prompt copy; the others are common confirmation
 * glyphs that users naturally reach for. All map to a positive sentiment in
 * `reactionToSentiment`, so they fit the existing scheme.
 */
export const INVESTIGATION_CONFIRM_REACTIONS = new Set<string>([
  'white_check_mark',
  'heavy_check_mark',
  '+1',
  'thumbsup',
]);

export type ResumeGateDecision =
  | { ok: true }
  | { ok: false; reason: 'reaction_not_confirm' | 'no_pending_findings' | 'reactor_not_allowed' };

/**
 * Pure decision helper for the reaction-resume gate in
 * `processReactionFeedback`. Lifted out so it can be unit-tested without
 * spinning up the whole sidecar (module-scope `store`/`config`/queue).
 *
 * Returns `ok: true` only when:
 *  - the reaction is one of the explicit confirm glyphs,
 *  - findings exist for the reacted prompt message,
 *  - the reactor is the original requester OR a configured admin.
 *
 * Any other case returns `ok: false` with a `reason` tag suitable for logging.
 */
export function shouldResumeFromReaction(params: {
  reaction: string;
  reactorUserId: string;
  findings: InvestigationFindings | undefined;
  adminUserIds: string[];
}): ResumeGateDecision {
  if (!INVESTIGATION_CONFIRM_REACTIONS.has(params.reaction)) {
    return { ok: false, reason: 'reaction_not_confirm' };
  }
  if (!params.findings) {
    return { ok: false, reason: 'no_pending_findings' };
  }
  const allowed = new Set<string>(
    [params.findings.requesterUserId, ...params.adminUserIds].filter((id): id is string => Boolean(id)),
  );
  if (!allowed.has(params.reactorUserId)) {
    return { ok: false, reason: 'reactor_not_allowed' };
  }
  return { ok: true };
}
