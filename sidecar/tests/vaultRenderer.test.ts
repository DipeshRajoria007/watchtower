import { describe, expect, it } from 'vitest';
import { AUTO_BEGIN_MARKER, AUTO_END_MARKER, composeFile, splitAutoBlock } from '../src/vault/vaultRenderer.js';

// Note: renderUserNote layout tests live in vaultRendererThreeSection.test.ts
// (Phase D introduced the three-section format — About / Things to remember /
// Recent work). This file retains coverage for the structural helpers
// splitAutoBlock and composeFile which are layout-agnostic.

const NOW = new Date('2026-05-03T12:00:00Z');

describe('splitAutoBlock', () => {
  it('returns null when markers are missing', () => {
    expect(splitAutoBlock('no markers here')).toBeNull();
  });

  it('captures pre/auto/post sections', () => {
    const raw = `head\n${AUTO_BEGIN_MARKER}\nbody\n${AUTO_END_MARKER}\ntrailer`;
    const split = splitAutoBlock(raw);
    expect(split?.before.trim()).toBe('head');
    expect(split?.auto.trim()).toBe('body');
    expect(split?.after.trim()).toBe('trailer');
  });
});

describe('composeFile', () => {
  it('appends auto block when prior content has no markers', () => {
    const out = composeFile({
      frontmatter: { miniog_kind: 'user', miniog_rendered_at: NOW.toISOString() },
      autoBody: 'auto-body',
      prior: 'old freeform notes',
    });
    expect(out).toContain(AUTO_BEGIN_MARKER);
    expect(out).toContain('old freeform notes');
  });
});
