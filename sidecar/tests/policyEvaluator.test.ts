import { describe, expect, it, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPolicies, evaluatePolicy, getPolicySnapshot } from '../src/policies/evaluator.js';

describe('policyEvaluator', () => {
  let policiesDir: string;

  beforeEach(() => {
    policiesDir = path.join(os.tmpdir(), `wt-policy-test-${randomUUID()}`);
    fs.mkdirSync(policiesDir, { recursive: true });
  });

  it('allows everything when no policies are loaded', () => {
    loadPolicies(path.join(os.tmpdir(), 'nonexistent-policies'));
    expect(evaluatePolicy('U1', 'force push to main', ['UOWNER'])).toEqual({ allowed: true });
  });

  it('blocks critical-deny rules for all users including owners', () => {
    fs.writeFileSync(
      path.join(policiesDir, 'critical.md'),
      `---
tier: critical-deny
description: Critical
---

## no-force-push
Block force push.
match: force push, --force
`,
    );

    loadPolicies(policiesDir);

    const ownerResult = evaluatePolicy('UOWNER', 'please force push this to main', ['UOWNER']);
    expect(ownerResult.allowed).toBe(false);
    expect(ownerResult).toHaveProperty('tier', 'critical-deny');

    const userResult = evaluatePolicy('U1', 'can you force push?', ['UOWNER']);
    expect(userResult.allowed).toBe(false);
  });

  it('blocks non-master rules only for non-owner users', () => {
    fs.writeFileSync(
      path.join(policiesDir, 'non-master.md'),
      `---
tier: non-master
description: Non-owner
---

## no-deploy
Cannot deploy.
match: deploy, ship to prod
`,
    );

    loadPolicies(policiesDir);

    const userResult = evaluatePolicy('U1', 'deploy the frontend', ['UOWNER']);
    expect(userResult.allowed).toBe(false);
    expect(userResult).toHaveProperty('tier', 'non-master');

    const ownerResult = evaluatePolicy('UOWNER', 'deploy the frontend', ['UOWNER']);
    expect(ownerResult.allowed).toBe(true);
  });

  it('exempts core-dev non-owner users from non-master rules', () => {
    fs.writeFileSync(
      path.join(policiesDir, 'non-master.md'),
      `---
tier: non-master
description: Non-owner
---

## no-deploy
Cannot deploy.
match: deploy, ship to prod
`,
    );

    loadPolicies(policiesDir);

    // Core-dev (includes owners) should be exempt
    const coreDevResult = evaluatePolicy('UCOREDEV', 'deploy the frontend', ['UOWNER', 'UCOREDEV']);
    expect(coreDevResult.allowed).toBe(true);

    // Non-core-dev should be blocked
    const regularResult = evaluatePolicy('URANDOM', 'deploy the frontend', ['UOWNER', 'UCOREDEV']);
    expect(regularResult.allowed).toBe(false);
  });

  it('returns policy snapshot', () => {
    fs.writeFileSync(
      path.join(policiesDir, 'test.md'),
      `---
tier: critical-deny
description: Test
---

## test-rule
Test.
match: test
`,
    );

    loadPolicies(policiesDir);
    const snapshot = getPolicySnapshot();
    expect(snapshot.loaded).toBe(true);
    expect(snapshot.criticalDenyCount).toBe(1);
    expect(snapshot.nonMasterCount).toBe(0);
    expect(snapshot.rules).toHaveLength(1);
    expect(snapshot.rules[0].id).toBe('test-rule');
  });
});
