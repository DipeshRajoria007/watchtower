/**
 * Lightweight keyword classifier that identifies which product within
 * `newton-web` a job touches. The repo classifier already says "newton-web vs
 * newton-api"; this layers on top to answer "which newton-web product?"
 * because newton-web hosts many distinct products (NSAT timeline, JEE rank
 * predictor, NST samurai, newton box, playgrounds, …).
 *
 * The product list lives in this file as a const so adding a new product is
 * a one-line edit. If the catalogue grows beyond ~20 entries or starts to
 * vary per installation, migrate this to `app_settings` and read via
 * JobStore. Until then, code-as-config is fine — keeps the classifier
 * trivially testable.
 */

export interface ProductRule {
  /** Stable key persisted in `learning_signals.product` and `user_product_affinity.product`. */
  key: string;
  /** Human-readable name used in renderers. */
  displayName: string;
  /** Ordered keyword regexes; weight is fixed per-rule, max-weight wins. */
  patterns: RegExp[];
}

export const PRODUCT_RULES: ReadonlyArray<ProductRule> = [
  {
    key: 'nsat-timeline',
    displayName: 'NSAT timeline',
    patterns: [/\bnsat\b/i, /national skill assessment/i, /\bnsat[- ]?timeline\b/i],
  },
  {
    key: 'jee-rank-predictor',
    displayName: 'JEE rank predictor',
    patterns: [/\brank\s*predictor\b/i, /\bjee\s*rank\b/i, /\brank\s*pred\b/i],
  },
  {
    key: 'nst-samurai',
    displayName: 'NST Samurai',
    patterns: [/\bsamurai\b/i, /\bnst[- ]?samurai\b/i],
  },
  {
    key: 'newton-box',
    displayName: 'Newton Box',
    patterns: [/\bnewton[- ]?box\b/i, /\bnewtonbox\b/i],
  },
  {
    key: 'playgrounds',
    displayName: 'Playgrounds',
    patterns: [/\bplaygrounds?\b/i],
  },
];

export interface ProductClassification {
  selected: string | null;
  confidence: number;
  signals: string[];
}

/**
 * Classify the highest-scoring product by keyword matches across the input
 * texts. Each matched pattern contributes 1 to a rule's score; the rule
 * with the highest score wins. Ties favor the rule listed first. Returns
 * null when no rule matches.
 *
 * The classifier is intentionally simple: false positives are tolerated
 * (the affinity rollup is advisory; nothing gates an action on it). False
 * negatives are also fine — unmatched jobs just don't carry a product tag,
 * and the dossier degrades to repo-level granularity for that user.
 */
export function classifyProduct(texts: ReadonlyArray<string>): ProductClassification {
  const corpus = texts.filter(t => typeof t === 'string' && t.length > 0).join('\n');
  if (!corpus) return { selected: null, confidence: 0, signals: [] };

  let best: { rule: ProductRule; score: number; signals: string[] } | null = null;
  for (const rule of PRODUCT_RULES) {
    let score = 0;
    const signals: string[] = [];
    for (const pattern of rule.patterns) {
      if (pattern.test(corpus)) {
        score += 1;
        signals.push(`${rule.key}:${pattern.source}`);
      }
    }
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { rule, score, signals };
    }
  }

  if (!best) return { selected: null, confidence: 0, signals: [] };
  // Confidence is the share of this rule's patterns that matched; nothing
  // semantic, just bounded 0..1 for log readability.
  const confidence = best.score / Math.max(1, best.rule.patterns.length);
  return { selected: best.rule.key, confidence, signals: best.signals };
}

/** Lookup a product's display name by key, for renderers. */
export function productDisplayName(key: string): string {
  const rule = PRODUCT_RULES.find(r => r.key === key);
  return rule?.displayName ?? key;
}
