import { describe, expect, it } from 'vitest';
import { diagnoseFailure } from '../src/learning/failureDoctor.js';

describe('failureDoctor', () => {
  it('diagnoses missing codex binary', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'OWNER_AUTOPILOT',
      message: 'Workflow failed after retries: Error: spawn codex ENOENT',
      logs: [],
    });

    expect(diagnosis?.errorKind).toBe('CODEX_BIN_NOT_FOUND');
    expect(diagnosis?.summary).toContain('Codex CLI');
  });

  it('diagnoses native module ABI mismatch', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'BUG_FIX',
      message: 'ERR_DLOPEN_FAILED',
      logs: [
        {
          stage: 'boot',
          message: 'better-sqlite3 was compiled against NODE_MODULE_VERSION 115',
          level: 'ERROR',
        },
      ],
    });

    expect(diagnosis?.errorKind).toBe('NATIVE_MODULE_ABI_MISMATCH');
  });

  it('returns undefined for unrecognized failures', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'PR_REVIEW',
      message: 'something unexpected but generic happened',
      logs: [],
    });

    expect(diagnosis).toBeUndefined();
  });
});
