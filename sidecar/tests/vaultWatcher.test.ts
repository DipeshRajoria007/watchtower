import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import {
  __resetVaultWatcherForTests,
  configureVaultWatcher,
  parseFrontmatter,
  parseOperatorEdits,
  shutdownVaultWatcher,
} from '../src/vault/vaultWatcher.js';
import {
  __resetVaultWriterForTests,
  configureVaultWriter,
  flushVault,
  scheduleVaultRender,
  shutdownVaultWriter,
} from '../src/vault/vaultWriter.js';
import { slugify, userNotePath } from '../src/vault/vaultPaths.js';
import { AUTO_BEGIN_MARKER, AUTO_END_MARKER } from '../src/vault/vaultRenderer.js';

afterEach(async () => {
  await shutdownVaultWatcher();
  shutdownVaultWriter();
  __resetVaultWatcherForTests();
  __resetVaultWriterForTests();
});

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'watchtower-vault-watch-'));
}

function buildUserNote(opts: { userId: string; rendered: string; before?: string; after?: string }): string {
  const { userId, rendered, before = '', after = '' } = opts;
  return [
    '---',
    'miniog_kind: user',
    `miniog_user_id: ${userId}`,
    `miniog_rendered_at: ${rendered}`,
    '---',
    '',
    before,
    AUTO_BEGIN_MARKER,
    '## Profile',
    `- **User ID**: \`${userId}\``,
    AUTO_END_MARKER,
    after,
    '',
  ].join('\n');
}

describe('parseFrontmatter', () => {
  it('extracts known fields', () => {
    const fm = parseFrontmatter('---\nminiog_kind: user\nminiog_user_id: U1\n---\nbody');
    expect(fm).toEqual({ miniog_kind: 'user', miniog_user_id: 'U1' });
  });

  it('returns null without leading frontmatter', () => {
    expect(parseFrontmatter('no frontmatter here')).toBeNull();
  });

  it('returns null when closing fence is missing', () => {
    expect(parseFrontmatter('---\nminiog_kind: user\nbody never closes')).toBeNull();
  });
});

describe('parseOperatorEdits', () => {
  it('reads Role: and Notes: from outside the auto block', () => {
    const file = buildUserNote({
      userId: 'U1',
      rendered: '2026-05-03T00:00:00Z',
      after: 'Role: dev\nNotes: ships tests with every PR',
    });
    expect(parseOperatorEdits(file)).toEqual({ role: 'dev', notes: 'ships tests with every PR' });
  });

  it('treats explicit empty as null (clear)', () => {
    const file = buildUserNote({ userId: 'U1', rendered: 'x', after: 'Role: <none>\nNotes:' });
    expect(parseOperatorEdits(file)).toEqual({ role: null, notes: null });
  });

  it('ignores invalid roles (treats as no change)', () => {
    const file = buildUserNote({ userId: 'U1', rendered: 'x', after: 'Role: wizard\nNotes: hi' });
    const edits = parseOperatorEdits(file);
    expect(edits.role).toBeUndefined();
    expect(edits.notes).toBe('hi');
  });

  it('ignores Role/Notes inside the auto block', () => {
    const file = [
      '---\nminiog_kind: user\nminiog_user_id: U1\nminiog_rendered_at: x\n---\n',
      AUTO_BEGIN_MARKER,
      '\nRole: dev\nNotes: poison\n',
      AUTO_END_MARKER,
      '\n',
    ].join('');
    expect(parseOperatorEdits(file)).toEqual({});
  });

  it('caps notes at 2KB', () => {
    const long = 'x'.repeat(3000);
    const file = buildUserNote({ userId: 'U1', rendered: 'x', after: `Notes: ${long}` });
    const edits = parseOperatorEdits(file);
    expect(edits.notes?.length).toBe(2048);
  });
});

describe('vault watcher integration', () => {
  it('lifts Role: edits into user_dossiers and re-renders', async () => {
    const vaultRoot = await makeTempDir();
    const store = new JobStore(':memory:');
    const dossiers = store.dossierStore();
    dossiers.firstSeen({ userId: 'U1', displayName: 'Dipesh' });

    configureVaultWriter({ store, vaultPath: vaultRoot, enabled: true });
    scheduleVaultRender({ kind: 'user', userId: 'U1' });
    await flushVault();

    const filePath = userNotePath(vaultRoot, slugify('Dipesh'));
    expect((await dossiers.getDossier('U1')).profile?.role).toBeFalsy();

    await configureVaultWatcher({ store, vaultPath: vaultRoot, enabled: true });

    // Operator edit: append a Role line below the auto block.
    const original = await fs.readFile(filePath, 'utf8');
    const tampered = original.replace('## My notes', '## My notes\nRole: pm\nNotes: PM lead for newton-web');
    // Bypass writer markRecentlyWritten by writing directly.
    await fs.writeFile(filePath, tampered, 'utf8');

    // Wait for chokidar to fire + adminEdit to run.
    let observed = '';
    for (let i = 0; i < 60; i++) {
      const dossier = dossiers.getDossier('U1');
      if (dossier.profile?.role === 'pm') {
        observed = dossier.profile.role;
        expect(dossier.profile.notes).toBe('PM lead for newton-web');
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(observed).toBe('pm');

    store.close();
  });

  it('lifts a new bullet under "## Things to remember" into user_pinned_facts', async () => {
    const vaultRoot = await makeTempDir();
    const store = new JobStore(':memory:');
    const dossiers = store.dossierStore();
    dossiers.firstSeen({ userId: 'U_PIN_ADD', displayName: 'PinAdd' });

    configureVaultWriter({ store, vaultPath: vaultRoot, enabled: true });
    scheduleVaultRender({ kind: 'user', userId: 'U_PIN_ADD' });
    await flushVault();

    const filePath = userNotePath(vaultRoot, slugify('PinAdd'));
    expect(dossiers.listPinnedFacts('U_PIN_ADD')).toHaveLength(0);

    await configureVaultWatcher({ store, vaultPath: vaultRoot, enabled: true });

    const original = await fs.readFile(filePath, 'utf8');
    const tampered = original.replace('<!-- empty -->', '<!-- empty -->\n- prefer terse PR review summaries');
    await fs.writeFile(filePath, tampered, 'utf8');

    let observed: string[] = [];
    for (let i = 0; i < 60; i++) {
      const facts = dossiers.listPinnedFacts('U_PIN_ADD');
      if (facts.length > 0) {
        observed = facts.map(f => f.text);
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(observed).toEqual(['prefer terse PR review summaries']);
    store.close();
  });

  it('removes a fact from user_pinned_facts when its bullet is deleted from the file', async () => {
    const vaultRoot = await makeTempDir();
    const store = new JobStore(':memory:');
    const dossiers = store.dossierStore();
    dossiers.firstSeen({ userId: 'U_PIN_DEL', displayName: 'PinDel' });
    dossiers.addPinnedFact({ userId: 'U_PIN_DEL', text: 'fact-to-remove', source: 'slack-remember' });

    configureVaultWriter({ store, vaultPath: vaultRoot, enabled: true });
    scheduleVaultRender({ kind: 'user', userId: 'U_PIN_DEL' });
    await flushVault();

    const filePath = userNotePath(vaultRoot, slugify('PinDel'));
    expect(dossiers.listPinnedFacts('U_PIN_DEL')).toHaveLength(1);

    await configureVaultWatcher({ store, vaultPath: vaultRoot, enabled: true });

    // Operator deletes the bullet (replaces the line with the empty marker).
    const original = await fs.readFile(filePath, 'utf8');
    const tampered = original.replace('- fact-to-remove', '<!-- empty -->');
    await fs.writeFile(filePath, tampered, 'utf8');

    let removed = false;
    for (let i = 0; i < 60; i++) {
      if (dossiers.listPinnedFacts('U_PIN_DEL').length === 0) {
        removed = true;
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(removed).toBe(true);
    store.close();
  });
});
