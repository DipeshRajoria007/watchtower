import { logger } from '../logging/logger.js';

interface ViolationRecord {
  count: number;
  firstAt: number;
}

const BAN_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_VIOLATIONS_BEFORE_BAN = 3;
const BAN_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

/** userId → violation tracking */
const violations = new Map<string, ViolationRecord>();

/** userId → ban expiry timestamp */
const bans = new Map<string, number>();

export function recordViolation(userId: string): void {
  const now = Date.now();
  const existing = violations.get(userId);

  if (existing && now - existing.firstAt < BAN_WINDOW_MS) {
    existing.count += 1;
    if (existing.count >= MAX_VIOLATIONS_BEFORE_BAN) {
      bans.set(userId, now + BAN_DURATION_MS);
      violations.delete(userId);
      logger.warn({ userId, banUntil: new Date(now + BAN_DURATION_MS).toISOString() }, 'user auto-banned after repeated policy violations');
    }
  } else {
    violations.set(userId, { count: 1, firstAt: now });
  }
}

export function isUserBanned(userId: string): boolean {
  const banExpiry = bans.get(userId);
  if (!banExpiry) return false;

  if (Date.now() > banExpiry) {
    bans.delete(userId);
    return false;
  }
  return true;
}

export function clearBan(userId: string): void {
  bans.delete(userId);
  violations.delete(userId);
}
