import { describe, expect, it } from 'vitest';
import { INVESTIGATION_CONFIRM_REACTIONS, shouldResumeFromReaction } from '../src/router/investigationResumeGate.js';
import type { InvestigationFindings } from '../src/state/investigationStore.js';

function makeFindings(over: Partial<InvestigationFindings> = {}): InvestigationFindings {
  return {
    threadTs: '111.22',
    channelId: 'C1',
    jobId: 'job-prior',
    repoName: 'newton-web',
    summary: 'prior RCA',
    findingsJson: '{}',
    promptMessageTs: '111.30',
    requesterUserId: 'UREQUESTER',
    createdAt: '2026-05-18T07:08:00Z',
    updatedAt: '2026-05-18T07:08:00Z',
    ...over,
  };
}

describe('shouldResumeFromReaction', () => {
  it('confirms when ✅ from the original requester on a findings prompt', () => {
    expect(
      shouldResumeFromReaction({
        reaction: 'white_check_mark',
        reactorUserId: 'UREQUESTER',
        findings: makeFindings(),
        adminUserIds: ['UADMIN1', 'UADMIN2'],
      }),
    ).toEqual({ ok: true });
  });

  it('confirms when ✅ comes from a configured admin (requester not present)', () => {
    expect(
      shouldResumeFromReaction({
        reaction: 'white_check_mark',
        reactorUserId: 'UADMIN1',
        findings: makeFindings(),
        adminUserIds: ['UADMIN1'],
      }),
    ).toEqual({ ok: true });
  });

  it('also accepts thumbsup/+1/heavy_check_mark — common confirmation glyphs', () => {
    const findings = makeFindings();
    const adminUserIds = ['UADMIN'];
    for (const reaction of ['heavy_check_mark', '+1', 'thumbsup']) {
      expect(
        shouldResumeFromReaction({
          reaction,
          reactorUserId: 'UREQUESTER',
          findings,
          adminUserIds,
        }),
      ).toEqual({ ok: true });
      expect(INVESTIGATION_CONFIRM_REACTIONS.has(reaction)).toBe(true);
    }
  });

  it('rejects non-confirm reactions even from the requester', () => {
    expect(
      shouldResumeFromReaction({
        reaction: 'eyes',
        reactorUserId: 'UREQUESTER',
        findings: makeFindings(),
        adminUserIds: ['UADMIN'],
      }),
    ).toEqual({ ok: false, reason: 'reaction_not_confirm' });
  });

  it('rejects when no investigation findings exist for the prompt message', () => {
    expect(
      shouldResumeFromReaction({
        reaction: 'white_check_mark',
        reactorUserId: 'UREQUESTER',
        findings: undefined,
        adminUserIds: ['UADMIN'],
      }),
    ).toEqual({ ok: false, reason: 'no_pending_findings' });
  });

  it('rejects when the reactor is neither the requester nor an admin', () => {
    expect(
      shouldResumeFromReaction({
        reaction: 'white_check_mark',
        reactorUserId: 'URANDOM',
        findings: makeFindings({ requesterUserId: 'UREQUESTER' }),
        adminUserIds: ['UADMIN'],
      }),
    ).toEqual({ ok: false, reason: 'reactor_not_allowed' });
  });

  it('rejects when findings has no requesterUserId and reactor is not an admin', () => {
    // Defensive: old findings rows from before the requester_user_id column was
    // added will have requesterUserId=undefined. In that case only admins should
    // be able to confirm.
    expect(
      shouldResumeFromReaction({
        reaction: 'white_check_mark',
        reactorUserId: 'URANDOM',
        findings: makeFindings({ requesterUserId: undefined }),
        adminUserIds: ['UADMIN'],
      }),
    ).toEqual({ ok: false, reason: 'reactor_not_allowed' });
  });
});
