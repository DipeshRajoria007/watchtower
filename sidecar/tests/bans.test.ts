import { describe, expect, it, beforeEach } from 'vitest';
import { recordViolation, isUserBanned, clearBan } from '../src/policies/bans.js';

describe('bans', () => {
  beforeEach(() => {
    clearBan('U_TEST');
  });

  it('does not ban after a single violation', () => {
    recordViolation('U_TEST');
    expect(isUserBanned('U_TEST')).toBe(false);
  });

  it('bans after 3 violations within the time window', () => {
    recordViolation('U_TEST');
    recordViolation('U_TEST');
    recordViolation('U_TEST');
    expect(isUserBanned('U_TEST')).toBe(true);
  });

  it('clears a ban', () => {
    recordViolation('U_TEST');
    recordViolation('U_TEST');
    recordViolation('U_TEST');
    expect(isUserBanned('U_TEST')).toBe(true);

    clearBan('U_TEST');
    expect(isUserBanned('U_TEST')).toBe(false);
  });

  it('returns false for non-banned user', () => {
    expect(isUserBanned('U_CLEAN')).toBe(false);
  });
});
