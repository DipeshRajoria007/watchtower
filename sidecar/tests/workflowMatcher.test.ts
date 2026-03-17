import { describe, expect, it } from 'vitest';
import { matchWorkflowTemplate } from '../src/workflows/matcher.js';
import type { WorkflowTemplate } from '../src/workflows/registry.js';

const templates: WorkflowTemplate[] = [
  {
    name: 'deploy-frontend',
    description: 'Deploy frontend app',
    triggers: ['deploy frontend', 'ship frontend'],
    keywords: ['deploy', 'frontend', 'release'],
    promptTemplate: 'Deploy {{user_message}}',
  },
  {
    name: 'hotfix',
    description: 'Create a hotfix',
    triggers: ['hotfix'],
    keywords: ['fix', 'urgent', 'production', 'bug'],
    promptTemplate: 'Hotfix {{user_message}}',
  },
];

describe('workflowMatcher', () => {
  it('matches a template by trigger phrase', () => {
    const result = matchWorkflowTemplate('please deploy frontend now', templates);
    expect(result?.name).toBe('deploy-frontend');
  });

  it('matches a template by keywords when no trigger matches', () => {
    const result = matchWorkflowTemplate('we have an urgent production bug to fix', templates);
    expect(result?.name).toBe('hotfix');
  });

  it('returns undefined when nothing matches above threshold', () => {
    const result = matchWorkflowTemplate('tell me about the weather', templates);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty templates', () => {
    const result = matchWorkflowTemplate('deploy frontend', []);
    expect(result).toBeUndefined();
  });
});
