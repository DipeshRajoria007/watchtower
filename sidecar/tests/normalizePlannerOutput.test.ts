import { describe, expect, it } from 'vitest';
import { normalizePlannerOutput } from '../src/agents/normalizePlannerOutput.js';

describe('normalizePlannerOutput', () => {
  describe('codex backend (structured JSON)', () => {
    it('maps the planner JSON fields onto the normalized shape and renders markdown from plan + affectedFiles', () => {
      const raw = {
        plan: ['Step one', 'Step two'],
        affectedFiles: ['src/foo.ts', 'src/bar.ts'],
        scope: 'medium',
        requiresCodeChanges: true,
        clarificationNeeded: null,
      };
      const result = normalizePlannerOutput(raw, 'codex');
      expect(result.scope).toBe('medium');
      expect(result.requiresCodeChanges).toBe(true);
      expect(result.clarificationNeeded).toBeNull();
      expect(result.affectedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
      expect(result.planMarkdown).toContain('1. Step one');
      expect(result.planMarkdown).toContain('2. Step two');
      expect(result.planMarkdown).toContain('**Affected files:**');
      expect(result.planMarkdown).toContain('`src/foo.ts`');
    });

    it('passes through a non-empty clarificationNeeded string', () => {
      const result = normalizePlannerOutput(
        {
          plan: [],
          affectedFiles: [],
          scope: 'small',
          requiresCodeChanges: false,
          clarificationNeeded: 'Which repo do you mean?',
        },
        'codex',
      );
      expect(result.clarificationNeeded).toBe('Which repo do you mean?');
      expect(result.requiresCodeChanges).toBe(false);
    });

    it('coerces invalid scope to medium and missing requiresCodeChanges to true', () => {
      const result = normalizePlannerOutput({ plan: ['x'], affectedFiles: [] }, 'codex');
      expect(result.scope).toBe('medium');
      expect(result.requiresCodeChanges).toBe(true);
    });

    it('treats empty/whitespace clarificationNeeded as null', () => {
      const result = normalizePlannerOutput(
        { plan: ['x'], affectedFiles: [], scope: 'small', requiresCodeChanges: true, clarificationNeeded: '   ' },
        'codex',
      );
      expect(result.clarificationNeeded).toBeNull();
    });
  });

  describe('claude-code backend (free-form plan-mode markdown)', () => {
    it('reads planMarkdown from the parsedJson summary fallback (plain-text path)', () => {
      const raw = {
        status: 'success',
        summary: '# Plan\n\n1. Read foo.ts\n2. Edit bar.ts\n\nScope: small',
        actions: [],
        prUrl: '',
      };
      const result = normalizePlannerOutput(raw, 'claude-code');
      expect(result.planMarkdown).toContain('1. Read foo.ts');
      expect(result.scope).toBe('small');
      expect(result.requiresCodeChanges).toBe(true);
      expect(result.clarificationNeeded).toBeNull();
      expect(result.affectedFiles).toEqual([]);
    });

    it('is idempotent: re-normalizing an already-normalized output preserves planMarkdown', () => {
      const first = normalizePlannerOutput({ summary: '# Plan\n1. Do thing\nScope: large' }, 'claude-code');
      const augmented = {
        planMarkdown: first.planMarkdown,
        scope: first.scope,
        affectedFiles: first.affectedFiles,
        requiresCodeChanges: first.requiresCodeChanges,
        clarificationNeeded: first.clarificationNeeded,
      };
      const second = normalizePlannerOutput(augmented, 'claude-code');
      expect(second.planMarkdown).toBe(first.planMarkdown);
      expect(second.scope).toBe('large');
    });

    it('defaults scope to medium when the markdown has no Scope: tag', () => {
      const result = normalizePlannerOutput({ summary: 'do some things' }, 'claude-code');
      expect(result.scope).toBe('medium');
    });

    it('handles a bare string input (unwrapped markdown)', () => {
      const result = normalizePlannerOutput('# Just markdown\n- bullet', 'claude-code');
      expect(result.planMarkdown).toContain('Just markdown');
    });
  });
});
