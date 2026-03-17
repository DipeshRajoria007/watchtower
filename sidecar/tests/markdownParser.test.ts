import { describe, expect, it } from 'vitest';
import { parsePolicyMarkdown } from '../src/policies/markdownParser.js';

describe('parsePolicyMarkdown', () => {
  it('parses a critical-deny policy file', () => {
    const content = `---
tier: critical-deny
description: Rules that block dangerous operations for all users
---

## no-force-push
Never allow force-push operations.
match: force push, force-push, --force

## no-drop-table
Never allow database drop operations.
match: drop table, drop database, truncate table
`;

    const result = parsePolicyMarkdown(content);
    expect(result).toBeDefined();
    expect(result!.tier).toBe('critical-deny');
    expect(result!.rules).toHaveLength(2);
    expect(result!.rules[0].id).toBe('no-force-push');
    expect(result!.rules[0].matchTerms).toEqual(['force push', 'force-push', '--force']);
    expect(result!.rules[1].id).toBe('no-drop-table');
    expect(result!.rules[1].matchTerms).toEqual(['drop table', 'drop database', 'truncate table']);
  });

  it('parses a non-master policy file', () => {
    const content = `---
tier: non-master
description: Rules for non-owner users
---

## no-deploy
Non-owners cannot deploy.
match: deploy, ship to prod, push to production
`;

    const result = parsePolicyMarkdown(content);
    expect(result).toBeDefined();
    expect(result!.tier).toBe('non-master');
    expect(result!.rules).toHaveLength(1);
  });

  it('returns undefined for invalid frontmatter', () => {
    expect(parsePolicyMarkdown('no frontmatter here')).toBeUndefined();
    expect(parsePolicyMarkdown('---\ntier: invalid\n---\n')).toBeUndefined();
  });

  it('handles empty rules gracefully', () => {
    const content = `---
tier: critical-deny
description: Empty policy
---
`;
    const result = parsePolicyMarkdown(content);
    expect(result).toBeDefined();
    expect(result!.rules).toHaveLength(0);
  });
});
