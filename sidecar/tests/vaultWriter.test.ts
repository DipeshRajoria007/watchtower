import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetVaultWriterForTests,
  atomicWriteIfChanged,
  configureVaultWriter,
  flushVault,
  scheduleVaultRender,
  shutdownVaultWriter,
} from '../src/vault/vaultWriter.js';
import { JobStore } from '../src/state/jobStore.js';
import { slugify, userNotePath } from '../src/vault/vaultPaths.js';

afterEach(() => {
  shutdownVaultWriter();
  __resetVaultWriterForTests();
});

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'watchtower-vault-'));
}

describe('atomicWriteIfChanged', () => {
  it('writes new files', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'a.md');
    const wrote = await atomicWriteIfChanged(file, 'hello');
    expect(wrote).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('hello');
  });

  it('skips writes when content is byte-identical', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'a.md');
    await fs.writeFile(file, 'same');
    const wrote = await atomicWriteIfChanged(file, 'same');
    expect(wrote).toBe(false);
  });

  it('overwrites when content differs', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'a.md');
    await fs.writeFile(file, 'old');
    const wrote = await atomicWriteIfChanged(file, 'new');
    expect(wrote).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('new');
  });
});

describe('vault writer flush', () => {
  it('renders a user note when scheduleVaultRender is called and flushed', async () => {
    const vaultRoot = await makeTempDir();
    const store = new JobStore(':memory:');
    store.dossierStore().firstSeen({ userId: 'U1', displayName: 'Dipesh' });
    configureVaultWriter({ store, vaultPath: vaultRoot, enabled: true });
    scheduleVaultRender({ kind: 'user', userId: 'U1' });
    await flushVault();

    const file = userNotePath(vaultRoot, slugify('Dipesh'));
    const body = await fs.readFile(file, 'utf8');
    expect(body).toContain('miniog_user_id: U1');
    expect(body).toContain('**Name**: Dipesh');
    store.close();
  });

  it('skips a re-render when content is unchanged', async () => {
    const vaultRoot = await makeTempDir();
    const store = new JobStore(':memory:');
    store.dossierStore().firstSeen({ userId: 'U2', displayName: 'Stable' });
    configureVaultWriter({ store, vaultPath: vaultRoot, enabled: true });
    scheduleVaultRender({ kind: 'user', userId: 'U2' });
    await flushVault();

    const file = userNotePath(vaultRoot, slugify('Stable'));
    const firstStat = await fs.stat(file);

    // Wait a touch so mtime would change if a write actually happened.
    await new Promise(r => setTimeout(r, 30));
    scheduleVaultRender({ kind: 'user', userId: 'U2' });
    await flushVault();

    const secondStat = await fs.stat(file);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    store.close();
  });

  it('treats scheduleVaultRender as a no-op when disabled', async () => {
    const vaultRoot = await makeTempDir();
    const store = new JobStore(':memory:');
    store.dossierStore().firstSeen({ userId: 'U3', displayName: 'Quiet' });
    configureVaultWriter({ store, vaultPath: vaultRoot, enabled: false });
    scheduleVaultRender({ kind: 'user', userId: 'U3' });
    await flushVault();

    const file = userNotePath(vaultRoot, slugify('Quiet'));
    await expect(fs.access(file)).rejects.toThrow();
    store.close();
  });
});

describe('vaultPaths.slugify', () => {
  it('produces stable slugs from display names', () => {
    expect(slugify('Dipesh Rajoria')).toBe('dipesh-rajoria');
    expect(slugify('  weird name!! ')).toBe('weird-name');
    expect(slugify('')).toBe('unknown');
    expect(slugify(null)).toBe('unknown');
  });
});
