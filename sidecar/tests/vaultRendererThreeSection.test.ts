import { describe, expect, it } from 'vitest';
import {
  AUTO_BEGIN_MARKER,
  AUTO_END_MARKER,
  PINNED_LIST_BEGIN,
  PINNED_LIST_END,
  parsePinnedListFromAutoBody,
  renderUserAutoBody,
  renderUserNote,
} from '../src/vault/vaultRenderer.js';
import type { PinnedFactRow, UserDossier, UserMemoryRow } from '../src/state/dossierStore.js';

const NOW = new Date('2026-05-04T12:00:00Z');

function makeDossier(overrides: Partial<UserDossier> = {}): UserDossier {
  return {
    profile: {
      userId: 'U1',
      displayName: 'theOG',
      role: 'dev',
      firstSeenAt: '2026-05-01T00:00:00Z',
      updatedAt: NOW.toISOString(),
    },
    affinity: [],
    productAffinity: [],
    metrics: {},
    tone: 'normal',
    ...overrides,
  };
}

function makeFact(overrides: Partial<PinnedFactRow> = {}): PinnedFactRow {
  return {
    id: 1,
    userId: 'U1',
    text: 'prefers terse PR review summaries',
    source: 'slack-remember',
    createdAt: '2026-05-03T00:00:00Z',
    updatedAt: '2026-05-03T00:00:00Z',
    ...overrides,
  };
}

function makeMemory(overrides: Partial<UserMemoryRow> = {}): UserMemoryRow {
  return {
    id: 1,
    userId: 'U1',
    jobId: 'j-1',
    workflow: 'IMPLEMENTATION',
    status: 'SUCCESS',
    repo: 'newton-web',
    prUrl: null,
    product: null,
    summary: 'Fixed dashboard hydration error',
    createdAt: '2026-05-04T10:00:00Z',
    ...overrides,
  };
}

describe('renderUserAutoBody — three-section layout', () => {
  it('emits About / Things to remember / Recent work in that order', () => {
    const body = renderUserAutoBody({
      dossier: makeDossier(),
      pinnedFacts: [makeFact()],
      memories: [makeMemory()],
    });
    const aboutIdx = body.indexOf('## About');
    const remIdx = body.indexOf('## Things to remember');
    const workIdx = body.indexOf('## Recent work');
    expect(aboutIdx).toBeGreaterThanOrEqual(0);
    expect(remIdx).toBeGreaterThan(aboutIdx);
    expect(workIdx).toBeGreaterThan(remIdx);
  });

  it('uses the inferred profile when available', () => {
    const body = renderUserAutoBody({
      dossier: makeDossier({
        metrics: { inferred_profile: { text: 'theOG is the project owner working primarily on newton-web.' } },
      }),
    });
    expect(body).toContain('theOG is the project owner working primarily on newton-web.');
    expect(body).not.toContain("hasn't synthesized");
  });

  it('falls back to compact prose when no inferred profile yet', () => {
    const body = renderUserAutoBody({ dossier: makeDossier() });
    expect(body).toContain('*theOG*');
    expect(body).toContain("hasn't synthesized");
  });

  it('wraps the pinned-fact list in pinned-{begin,end} markers', () => {
    const body = renderUserAutoBody({
      dossier: makeDossier(),
      pinnedFacts: [makeFact({ text: 'fact A' }), makeFact({ id: 2, text: 'fact B' })],
    });
    expect(body).toContain(PINNED_LIST_BEGIN);
    expect(body).toContain(PINNED_LIST_END);
    expect(body).toContain('- fact A');
    expect(body).toContain('- fact B');
  });

  it('shows an empty marker (not blank) when no pinned facts', () => {
    const body = renderUserAutoBody({ dossier: makeDossier() });
    expect(body).toContain('<!-- empty -->');
  });

  it('renders memories with date / workflow / repo / summary / pr_url', () => {
    const body = renderUserAutoBody({
      dossier: makeDossier(),
      memories: [
        makeMemory({
          createdAt: '2026-05-01T00:00:00Z',
          workflow: 'INVESTIGATION',
          repo: 'newton-api',
          product: 'jee-rank-predictor',
          prUrl: 'https://github.com/x/y/pull/3421',
          summary: 'Diagnosed timeout',
        }),
      ],
    });
    expect(body).toContain('**2026-05-01**');
    expect(body).toContain('INVESTIGATION SUCCESS');
    expect(body).toContain('newton-api');
    expect(body).toContain('JEE rank predictor');
    expect(body).toContain('https://github.com/x/y/pull/3421');
    expect(body).toContain('Diagnosed timeout');
  });

  it('handles empty memories array gracefully', () => {
    const body = renderUserAutoBody({ dossier: makeDossier() });
    expect(body).toContain('## Recent work');
    expect(body).toContain('No tracked interactions yet.');
  });
});

describe('parsePinnedListFromAutoBody', () => {
  it('extracts bullets between the markers', () => {
    const auto = ['## Things to remember', PINNED_LIST_BEGIN, '- fact A', '- fact B', PINNED_LIST_END].join('\n');
    expect(parsePinnedListFromAutoBody(auto)).toEqual(['fact A', 'fact B']);
  });

  it('returns null when markers are missing', () => {
    expect(parsePinnedListFromAutoBody('## Things to remember\n- fact A\n')).toBeNull();
  });

  it('treats the empty-marker comment as no entries', () => {
    const auto = [PINNED_LIST_BEGIN, '<!-- empty -->', PINNED_LIST_END].join('\n');
    expect(parsePinnedListFromAutoBody(auto)).toEqual([]);
  });

  it('accepts asterisk and dash bullets, trims whitespace', () => {
    const auto = [PINNED_LIST_BEGIN, '   - alpha  ', '* bravo', '+ ignored', PINNED_LIST_END].join('\n');
    expect(parsePinnedListFromAutoBody(auto)).toEqual(['alpha', 'bravo']);
  });
});

describe('renderUserNote — operator content preservation', () => {
  it('keeps text outside the auto block intact across rerenders', () => {
    const first = renderUserNote({ dossier: makeDossier(), now: NOW });
    const operatorEdited = first + '\n\n## My freeform notes\n- I love hydration bugs.\n';
    const second = renderUserNote({
      dossier: makeDossier(),
      pinnedFacts: [makeFact({ text: 'new fact' })],
      prior: operatorEdited,
      now: NOW,
    });
    expect(second).toContain('I love hydration bugs.');
    expect(second).toContain('- new fact');
  });

  it('regenerates the auto block on rerender (operator edits inside it discarded)', () => {
    const first = renderUserNote({
      dossier: makeDossier(),
      pinnedFacts: [makeFact({ text: 'original' })],
      now: NOW,
    });
    // Simulate the operator hand-tampering with the About prose inside the auto block:
    const tampered = first.replace('*theOG*', '*NOT THEOG*');
    const second = renderUserNote({
      dossier: makeDossier(),
      pinnedFacts: [makeFact({ text: 'original' })],
      prior: tampered,
      now: NOW,
    });
    expect(second).toContain('*theOG*');
    expect(second).not.toContain('NOT THEOG');
  });

  it('always wraps the auto block in BEGIN/END markers', () => {
    const body = renderUserNote({ dossier: makeDossier(), now: NOW });
    expect(body).toContain(AUTO_BEGIN_MARKER);
    expect(body).toContain(AUTO_END_MARKER);
  });
});
