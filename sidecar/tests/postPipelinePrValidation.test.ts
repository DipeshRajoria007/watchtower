import { describe, expect, it } from 'vitest';
import { validatePushScope as __validatePushScopeForTests } from '../src/github/postPipelinePr.js';

describe('validatePushScope', () => {
  it('passes when commit count is within bounds and no expected files set', () => {
    const result = __validatePushScopeForTests({
      commitCount: 1,
      changedFiles: ['a.ts'],
      maxCommits: 5,
    });
    expect(result.ok).toBe(true);
  });

  it('fails when commit count exceeds maxCommits', () => {
    const result = __validatePushScopeForTests({
      commitCount: 12,
      changedFiles: ['a.ts'],
      maxCommits: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/12 commits/);
    }
  });

  it('fails when branch touches files outside planner scope', () => {
    const result = __validatePushScopeForTests({
      commitCount: 1,
      changedFiles: ['placements/utils.py', 'marketing/views.py'],
      expectedFiles: ['placements/utils.py'],
      maxCommits: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/marketing\/views\.py/);
    }
  });

  it('passes when all changed files match expected (with repo-prefix tolerance)', () => {
    const result = __validatePushScopeForTests({
      commitCount: 1,
      changedFiles: ['placements/utils.py'],
      expectedFiles: ['newton-api/placements/utils.py'],
      maxCommits: 5,
    });
    expect(result.ok).toBe(true);
  });

  it('treats empty expectedFiles as "no file-scope check"', () => {
    const result = __validatePushScopeForTests({
      commitCount: 1,
      changedFiles: ['foo.py', 'bar.py'],
      expectedFiles: [],
      maxCommits: 5,
    });
    expect(result.ok).toBe(true);
  });
});
