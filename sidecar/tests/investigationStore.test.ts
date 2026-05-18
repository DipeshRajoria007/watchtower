import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-invstore-')), 'watchtower.db');
}

describe('InvestigationStore — prompt-ts indexed lookup (D2)', () => {
  it('persists prompt_message_ts and requester_user_id; getByPromptMessageTs round-trips them', () => {
    const store = new JobStore(tempDbPath());
    const findings = store.investigationStore();

    findings.save({
      threadTs: '111.22',
      channelId: 'C-INV',
      jobId: 'job-1',
      repoName: 'newton-web',
      summary: 'sample RCA',
      findingsJson: '{"k":1}',
      promptMessageTs: '111.30',
      requesterUserId: 'UREQUESTER',
    });

    const byPrompt = findings.getByPromptMessageTs('C-INV', '111.30');
    expect(byPrompt).toBeDefined();
    expect(byPrompt?.threadTs).toBe('111.22');
    expect(byPrompt?.requesterUserId).toBe('UREQUESTER');
    expect(byPrompt?.promptMessageTs).toBe('111.30');

    // getForThread must still expose the new fields too.
    const byThread = findings.getForThread('111.22');
    expect(byThread?.promptMessageTs).toBe('111.30');
    expect(byThread?.requesterUserId).toBe('UREQUESTER');

    store.close();
  });

  it('returns undefined for an unmatched prompt-ts or wrong channel', () => {
    const store = new JobStore(tempDbPath());
    const findings = store.investigationStore();

    findings.save({
      threadTs: '111.22',
      channelId: 'C-INV',
      jobId: 'job-1',
      findingsJson: '{}',
      promptMessageTs: '111.30',
      requesterUserId: 'UREQUESTER',
    });

    expect(findings.getByPromptMessageTs('C-INV', '999.99')).toBeUndefined();
    expect(findings.getByPromptMessageTs('C-OTHER', '111.30')).toBeUndefined();
    store.close();
  });

  it('clear(threadTs) removes the row so a follow-up reaction is idempotent', () => {
    // Regression for the double-resume race noted in D2: after the reaction
    // dispatches the synthetic event, findings must be cleared so a second
    // reaction or a tagged "yes" arriving simultaneously can't re-fire.
    const store = new JobStore(tempDbPath());
    const findings = store.investigationStore();

    findings.save({
      threadTs: '111.22',
      channelId: 'C-INV',
      jobId: 'job-1',
      findingsJson: '{}',
      promptMessageTs: '111.30',
      requesterUserId: 'UREQUESTER',
    });

    expect(findings.getByPromptMessageTs('C-INV', '111.30')).toBeDefined();
    findings.clear('111.22');
    expect(findings.getByPromptMessageTs('C-INV', '111.30')).toBeUndefined();
    expect(findings.getForThread('111.22')).toBeUndefined();
    store.close();
  });
});
