import fs from 'node:fs';
import path from 'node:path';
import { parsePolicyMarkdown } from './markdownParser.js';
import { isUserBanned, recordViolation } from './bans.js';
import { logger } from '../logging/logger.js';
import type { PolicyRule } from './markdownParser.js';

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; tier: 'critical-deny' | 'non-master' | 'banned'; ruleId?: string };

let criticalDenyRules: PolicyRule[] = [];
let nonMasterRules: PolicyRule[] = [];
let policyLoaded = false;

const DEFAULT_POLICIES_DIR = path.resolve(process.cwd(), '.policies');

export function loadPolicies(policiesDir?: string): void {
  const dir = policiesDir ?? DEFAULT_POLICIES_DIR;
  criticalDenyRules = [];
  nonMasterRules = [];

  if (!fs.existsSync(dir)) {
    logger.info({ dir }, 'no .policies directory found, policy engine inactive');
    policyLoaded = false;
    return;
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    const parsed = parsePolicyMarkdown(content);
    if (!parsed) {
      logger.warn({ file }, 'could not parse policy file, skipping');
      continue;
    }

    if (parsed.tier === 'critical-deny') {
      criticalDenyRules.push(...parsed.rules);
    } else {
      nonMasterRules.push(...parsed.rules);
    }
  }

  policyLoaded = true;
  logger.info(
    { criticalDenyCount: criticalDenyRules.length, nonMasterCount: nonMasterRules.length },
    'policy engine loaded',
  );
}

function matchesRule(text: string, rule: PolicyRule): boolean {
  const normalized = text.toLowerCase();
  return rule.matchTerms.some(term => normalized.includes(term));
}

/**
 * Evaluates a request against loaded policies.
 *
 * @param userId - The Slack user ID
 * @param requestText - The raw message text from the user
 * @param privilegedUserIds - Core-dev (and owner) user IDs exempt from non-master rules
 */
export function evaluatePolicy(userId: string, requestText: string, privilegedUserIds: string[]): PolicyDecision {
  // If policies aren't loaded, allow everything
  if (!policyLoaded) {
    return { allowed: true };
  }

  // Check bans first
  if (isUserBanned(userId)) {
    return {
      allowed: false,
      reason: 'You are temporarily blocked due to repeated policy violations.',
      tier: 'banned',
    };
  }

  // Critical-deny rules apply to ALL users (including owners)
  for (const rule of criticalDenyRules) {
    if (matchesRule(requestText, rule)) {
      recordViolation(userId);
      return {
        allowed: false,
        reason: `Blocked by critical policy: ${rule.description}`,
        tier: 'critical-deny',
        ruleId: rule.id,
      };
    }
  }

  // Non-master rules apply only to non-privileged users (not core-dev/owner)
  const isOwner = privilegedUserIds.includes(userId);
  if (!isOwner) {
    for (const rule of nonMasterRules) {
      if (matchesRule(requestText, rule)) {
        return {
          allowed: false,
          reason: `Blocked by policy: ${rule.description}`,
          tier: 'non-master',
          ruleId: rule.id,
        };
      }
    }
  }

  return { allowed: true };
}

export function getPolicySnapshot(): {
  loaded: boolean;
  criticalDenyCount: number;
  nonMasterCount: number;
  rules: Array<{ id: string; tier: string; description: string }>;
} {
  return {
    loaded: policyLoaded,
    criticalDenyCount: criticalDenyRules.length,
    nonMasterCount: nonMasterRules.length,
    rules: [...criticalDenyRules, ...nonMasterRules].map(r => ({
      id: r.id,
      tier: r.tier,
      description: r.description,
    })),
  };
}
