import type { RepoClassificationResult } from '../types/contracts.js';

const WEB_SIGNAL_RULES: Array<[RegExp, number, string]> = [
  [/frontend|ui|ux|react|next\.js|component|css|styled|browser|page/i, 3, 'web-keyword'],
  [/TypeError: Cannot read properties|hydration|webpack|vite|dom/i, 2, 'web-stacktrace'],
  [/newton-web|\/pages\/|\/src\//i, 2, 'web-path-hint'],
];

const API_SIGNAL_RULES: Array<[RegExp, number, string]> = [
  [/backend|api|endpoint|django|serializer|celery|postgres|database|http 5\d\d/i, 3, 'api-keyword'],
  [/Traceback \(most recent call last\)|django\.core|IntegrityError/i, 2, 'api-stacktrace'],
  [/newton-api|\/manage\.py|\/requirements\.txt|\/newton\//i, 2, 'api-path-hint'],
];

export interface RepoAffinity {
  /** Hits in the user's last 30 days for newton-web. */
  newtonWebHits?: number;
  /** Hits in the user's last 30 days for newton-api. */
  newtonApiHits?: number;
}

/**
 * Soft prior multiplier. With 0 hits → 1.0 (neutral). Asymptotically capped
 * at 1.3× — strong text signals always dominate. tanh(hits/5) is roughly:
 *   1 hit ~ 1.06, 5 hits ~ 1.23, 20 hits ~ 1.30.
 */
function affinityPrior(hits: number | undefined): number {
  if (!hits || hits <= 0) return 1;
  return 1 + 0.3 * Math.tanh(hits / 5);
}

export function classifyRepo(texts: string[], threshold: number, affinity?: RepoAffinity): RepoClassificationResult {
  let scoreWeb = 0;
  let scoreApi = 0;
  const signals: string[] = [];

  for (const text of texts) {
    for (const [pattern, weight, signal] of WEB_SIGNAL_RULES) {
      if (pattern.test(text)) {
        scoreWeb += weight;
        signals.push(`${signal}:${pattern.source}`);
      }
    }
    for (const [pattern, weight, signal] of API_SIGNAL_RULES) {
      if (pattern.test(text)) {
        scoreApi += weight;
        signals.push(`${signal}:${pattern.source}`);
      }
    }
  }

  if (affinity) {
    const webPrior = affinityPrior(affinity.newtonWebHits);
    const apiPrior = affinityPrior(affinity.newtonApiHits);
    if (webPrior !== 1 || apiPrior !== 1) {
      scoreWeb *= webPrior;
      scoreApi *= apiPrior;
      signals.push(`affinity-prior:web=${webPrior.toFixed(2)}|api=${apiPrior.toFixed(2)}`);
    }
  }

  const total = scoreWeb + scoreApi;
  const confidence = total > 0 ? Math.max(scoreWeb, scoreApi) / total : 0;

  let selectedRepo: 'newton-web' | 'newton-api' | null = null;
  if (scoreWeb > scoreApi) {
    selectedRepo = 'newton-web';
  } else if (scoreApi > scoreWeb) {
    selectedRepo = 'newton-api';
  }

  const uncertain = !selectedRepo || confidence < threshold;

  return {
    selectedRepo,
    confidence,
    scoreWeb,
    scoreApi,
    signals,
    uncertain,
  };
}
