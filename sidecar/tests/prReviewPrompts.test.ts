import { describe, expect, it } from 'vitest';
import {
  buildPrReviewerPrompt,
  buildPrSecurityPrompt,
  buildPrPerformancePrompt,
} from '../src/agents/prReviewPrompts.js';

const prContext = {
  url: 'https://github.com/Newton-School/newton-web/pull/123',
  owner: 'Newton-School',
  repo: 'newton-web',
  number: 123,
};

const diff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,8 @@ function login(user: string) {
+  const token = generateToken(user);
+  return token;
 }`;

describe('buildPrReviewerPrompt', () => {
  it('includes diff, PR title, policy block, and thread context', () => {
    const prompt = buildPrReviewerPrompt({
      diff,
      prTitle: 'Add auth tokens',
      prBody: 'This PR adds JWT auth tokens',
      threadContext: 'Please review this',
      prContext,
      policyBlock: 'Active policy pack: frontend\n- No console.log in production',
    });

    expect(prompt).toContain(diff);
    expect(prompt).toContain('Add auth tokens');
    expect(prompt).toContain('This PR adds JWT auth tokens');
    expect(prompt).toContain('Please review this');
    expect(prompt).toContain('No console.log in production');
    expect(prompt).toContain(prContext.url);
    expect(prompt).toContain('file path and line number');
  });
});

describe('buildPrSecurityPrompt', () => {
  it('includes diff and PR context', () => {
    const prompt = buildPrSecurityPrompt({ diff, prTitle: 'Auth changes', prContext });

    expect(prompt).toContain(diff);
    expect(prompt).toContain('Auth changes');
    expect(prompt).toContain(prContext.url);
    expect(prompt).toContain('SQL injection');
    expect(prompt).toContain('file path and line number');
  });
});

describe('buildPrPerformancePrompt', () => {
  it('includes diff and PR context', () => {
    const prompt = buildPrPerformancePrompt({ diff, prTitle: 'Performance PR', prContext });

    expect(prompt).toContain(diff);
    expect(prompt).toContain('Performance PR');
    expect(prompt).toContain(prContext.url);
    expect(prompt).toContain('N+1');
    expect(prompt).toContain('file path and line number');
  });
});
