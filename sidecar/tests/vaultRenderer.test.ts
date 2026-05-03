import { describe, expect, it } from 'vitest';
import {
  AUTO_BEGIN_MARKER,
  AUTO_END_MARKER,
  composeFile,
  renderUserNote,
  splitAutoBlock,
} from '../src/vault/vaultRenderer.js';
import type { UserDossier } from '../src/state/dossierStore.js';

const NOW = new Date('2026-05-03T12:00:00Z');

function makeDossier(overrides: Partial<UserDossier> = {}): UserDossier {
  return {
    profile: {
      userId: 'U1',
      displayName: 'dipesh',
      role: 'pm',
      tz: 'Asia/Kolkata',
      firstSeenAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-03T00:00:00Z',
    },
    affinity: [{ repo: 'newton-web', hits: 12, successes: 10, failures: 2, computedAt: NOW.toISOString() }],
    metrics: {
      intent_mix: { IMPLEMENTATION: 8, INVESTIGATION: 3 },
      failure_fingerprint: { topErrorKinds: [{ kind: 'TypeError', count: 2 }], failureRate7d: 0.2, samples: 10 },
    },
    tone: 'normal',
    ...overrides,
  };
}

describe('renderUserNote', () => {
  it('emits frontmatter and an auto block with profile + affinity', () => {
    const md = renderUserNote({ dossier: makeDossier(), now: NOW });
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('miniog_kind: user');
    expect(md).toContain('miniog_user_id: U1');
    expect(md).toContain(AUTO_BEGIN_MARKER);
    expect(md).toContain(AUTO_END_MARKER);
    expect(md).toContain('**Name**: dipesh');
    expect(md).toContain('| newton-web | 12 |');
    expect(md).toContain('## My notes');
  });

  it('preserves operator content outside the auto markers on rerender', () => {
    const first = renderUserNote({ dossier: makeDossier(), now: NOW });
    const operatorEdited = first.replace('## My notes', '## My notes\n- Loves React, hates CSS.');
    const second = renderUserNote({ dossier: makeDossier({ tone: 'terse' }), prior: operatorEdited, now: NOW });
    expect(second).toContain('Loves React, hates CSS.');
    expect(second).toContain('## Tone');
    expect(second).toContain('**Mode**: terse');
  });

  it('regenerates the auto block (operator edits inside it are dropped)', () => {
    const first = renderUserNote({ dossier: makeDossier(), now: NOW });
    const tampered = first.replace('**Name**: dipesh', '**Name**: NOT DIPESH');
    const second = renderUserNote({ dossier: makeDossier(), prior: tampered, now: NOW });
    expect(second).toContain('**Name**: dipesh');
    expect(second).not.toContain('NOT DIPESH');
  });

  it('handles missing profile gracefully', () => {
    const md = renderUserNote({ dossier: makeDossier({ profile: null }), now: NOW });
    expect(md).toContain('No identity captured yet.');
  });
});

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
