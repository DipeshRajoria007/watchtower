import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import { __test__, assembleRecall } from '../src/codex/recallAssembler.js';
import {
  __resetVaultWriterForTests,
  configureVaultWriter,
  flushVault,
  scheduleVaultRender,
  shutdownVaultWriter,
} from '../src/vault/vaultWriter.js';

const { approxTokens, RECALL_BLOCK_BEGIN, RECALL_BLOCK_END } = __test__;

afterEach(() => {
  shutdownVaultWriter();
  __resetVaultWriterForTests();
});

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'watchtower-recall-'));
}

function emit(
  store: JobStore,
  partial: {
    jobId: string;
    userId: string;
    intent?: string;
    status?: 'SUCCESS' | 'FAILED';
    repo?: string;
    errorKind?: string;
  },
): void {
  store.recordLearningSignal({
    jobId: partial.jobId,
    eventId: `ev-${partial.jobId}`,
    channelId: 'C1',
    userId: partial.userId,
    workflow: 'IMPLEMENTATION',
    intent: (partial.intent ?? 'IMPLEMENTATION') as never,
    status: partial.status ?? 'SUCCESS',
    correctionApplied: false,
    errorKind: partial.errorKind,
    repo: partial.repo,
  });
}

describe('approxTokens', () => {
  it('uses ~char/4 sizing', () => {
    expect(approxTokens('')).toBe(0);
    expect(approxTokens('1234')).toBe(1);
    expect(approxTokens('1234567890')).toBe(3);
  });
});

describe('assembleRecall', () => {
  it('returns an empty block when there is nothing to surface', async () => {
    const store = new JobStore(':memory:');
    const result = await assembleRecall({
      userId: 'U_GHOST',
      workflow: 'IMPLEMENTATION',
      store,
    });
    expect(result.promptBlock).toBe('');
    expect(result.estimatedTokens).toBe(0);
    expect(result.sources).toEqual([]);
    store.close();
  });

  it('includes dossier and signals when both are available', async () => {
    const store = new JobStore(':memory:');
    store.dossierStore().firstSeen({ userId: 'U1', displayName: 'Dipesh' });
    for (let i = 0; i < 5; i++) {
      emit(store, { jobId: `j-${i}`, userId: 'U1', repo: 'newton-web', status: 'SUCCESS' });
    }
    // Trigger a rollup so affinity is populated.
    store.dossierStore().getDossier('U1');

    const result = await assembleRecall({
      userId: 'U1',
      workflow: 'IMPLEMENTATION',
      store,
    });
    expect(result.promptBlock).toContain(RECALL_BLOCK_BEGIN);
    expect(result.promptBlock).toContain(RECALL_BLOCK_END);
    expect(result.promptBlock).toContain('User: Dipesh');
    expect(result.promptBlock).toContain('Recent activity:');
    expect(result.sources).toContain('dossier');
    expect(result.sources).toContain('signals');
    store.close();
  });

  it('drops vault block first when over budget', async () => {
    const vaultRoot = await makeTempDir();
    const store = new JobStore(':memory:');
    store.dossierStore().firstSeen({ userId: 'U2', displayName: 'Verbose' });
    for (let i = 0; i < 5; i++) {
      emit(store, { jobId: `j-${i}`, userId: 'U2', repo: 'newton-web', status: 'SUCCESS' });
    }
    store.dossierStore().getDossier('U2');

    configureVaultWriter({ store, vaultPath: vaultRoot, enabled: true });
    scheduleVaultRender({ kind: 'user', userId: 'U2' });
    await flushVault();

    // With a tiny budget, the dossier line alone (~30-50 tokens) survives;
    // signals (~30 tokens × 5) and the vault note are dropped.
    const result = await assembleRecall({
      userId: 'U2',
      workflow: 'IMPLEMENTATION',
      store,
      vaultRoot,
      tokenBudget: 60,
    });
    expect(result.sources).not.toContain('vault');
    // dossier is the last to drop — it should be present (or block empty).
    if (result.promptBlock !== '') {
      expect(result.sources).toContain('dossier');
    }
    store.close();
  });

  it('reads vault operator notes when present and budget allows', async () => {
    const vaultRoot = await makeTempDir();
    const store = new JobStore(':memory:');
    store.dossierStore().firstSeen({ userId: 'U3', displayName: 'Operator-Edited' });
    configureVaultWriter({ store, vaultPath: vaultRoot, enabled: true });
    scheduleVaultRender({ kind: 'user', userId: 'U3' });
    await flushVault();

    // Append operator content directly to the file.
    const { slugify, userNotePath } = await import('../src/vault/vaultPaths.js');
    const filePath = userNotePath(vaultRoot, slugify('Operator-Edited'));
    const original = await fs.readFile(filePath, 'utf8');
    await fs.writeFile(filePath, original + '\n\nOperator says: this user prefers terse replies.\n');

    const result = await assembleRecall({
      userId: 'U3',
      workflow: 'IMPLEMENTATION',
      store,
      vaultRoot,
    });
    expect(result.promptBlock).toContain('Operator says: this user prefers terse replies.');
    expect(result.sources).toContain('vault');
    store.close();
  });
});
