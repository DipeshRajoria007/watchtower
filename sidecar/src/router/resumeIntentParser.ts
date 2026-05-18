/**
 * Resume-intent helpers used by the router to detect deterministic "yes, fix it"
 * style replies that should bypass the AI classifier.
 *
 * Why this exists: investigationWorkflow.ts:171 prompts the user to reply with
 * "yes, fix it" to continue from saved findings, but a bare affirmation gets
 * classified as CONVERSATIONAL by the AI classifier and miniOG silently runs
 * a conversational workflow that hallucinates a "fix done" message — see
 * thread `p1779086230428739` (2026-05-18). The router needs a pre-classifier
 * shortcut that catches these affirmations only when there is a pending
 * `investigation_findings` row for the thread to consume.
 *
 * Design constraints:
 * - Conservative match. False positives silently escalate to builder access
 *   (via IMPLEMENTATION), so the regex is anchored end-to-end and only catches
 *   short, unambiguous affirmation phrases.
 * - No DB awareness here. The router pairs this matcher with an
 *   `investigationStore.getForThread` lookup; this file is pure-string.
 */

// Anchored so partial sentences don't match. Only the affirmation token (and
// optional terminal punctuation) is allowed. "yes but" / "yes the bug is real"
// fall through to the classifier as before.
const AFFIRMATION_RE =
  /^\s*(?:yes(?:\s*,?\s*(?:please|fix\s*it|go(?:\s*ahead)?|do\s*it|ship\s*it))?|yep|yeah|yup|sure|go\s*ahead|do\s*it|proceed|fix\s*it|ship\s*it|ok(?:ay)?)\s*[.!?]?\s*$/i;

export function looksLikeFixAffirmation(text: string): boolean {
  if (!text) return false;
  return AFFIRMATION_RE.test(text);
}
