import { describe, expect, it, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWorkflowTemplates, getWorkflowTemplates, findTemplateByName } from '../src/workflows/registry.js';

describe('workflowRegistry', () => {
  let workflowsDir: string;

  beforeEach(() => {
    workflowsDir = path.join(os.tmpdir(), `wt-workflows-test-${randomUUID()}`);
  });

  it('returns empty when directory does not exist', () => {
    loadWorkflowTemplates(path.join(os.tmpdir(), 'nonexistent-workflows'));
    expect(getWorkflowTemplates()).toEqual([]);
  });

  it('loads workflow templates from directory', () => {
    const deployDir = path.join(workflowsDir, 'deploy');
    fs.mkdirSync(deployDir, { recursive: true });
    fs.writeFileSync(
      path.join(deployDir, 'workflow.yaml'),
      `
name: deploy-frontend
description: Deploy the frontend
triggers: [deploy frontend, ship frontend]
keywords: [deploy, frontend]
`,
    );
    fs.writeFileSync(path.join(deployDir, 'prompt.md'), 'Deploy the thing: {{user_message}}');

    loadWorkflowTemplates(workflowsDir);
    const templates = getWorkflowTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('deploy-frontend');
    expect(templates[0].triggers).toEqual(['deploy frontend', 'ship frontend']);
    expect(templates[0].promptTemplate).toContain('{{user_message}}');
  });

  it('finds template by name', () => {
    const testDir = path.join(workflowsDir, 'test');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'workflow.yaml'),
      `name: my-workflow\ndescription: Test\ntriggers: [test]\nkeywords: []`,
    );
    fs.writeFileSync(path.join(testDir, 'prompt.md'), 'Test prompt');

    loadWorkflowTemplates(workflowsDir);
    expect(findTemplateByName('my-workflow')).toBeDefined();
    expect(findTemplateByName('nonexistent')).toBeUndefined();
  });

  it('skips directories without required files', () => {
    const incompleteDir = path.join(workflowsDir, 'incomplete');
    fs.mkdirSync(incompleteDir, { recursive: true });
    fs.writeFileSync(path.join(incompleteDir, 'workflow.yaml'), 'name: incomplete');
    // Missing prompt.md

    loadWorkflowTemplates(workflowsDir);
    expect(getWorkflowTemplates()).toHaveLength(0);
  });
});
