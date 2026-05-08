import { describe, expect, it } from 'vitest';
import { buildMentionSystemPrompt } from '../src/codex/mentionSystemPrompt.js';
import type { NormalizedTask } from '../src/types/contracts.js';

function makeTask(overrides?: Partial<NormalizedTask>): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: 'C1',
      threadTs: '123.45',
      eventTs: '123.45',
      userId: 'U1',
      text: '<@UBOT1> do something',
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'UNKNOWN',
    ...overrides,
  };
}

describe('mentionSystemPrompt', () => {
  it('includes owner execution rule for owner-authored mentions', () => {
    const prompt = buildMentionSystemPrompt({
      task: makeTask({ isOwnerAuthor: true, isCoreDevAuthor: true, intent: 'OWNER_AUTOPILOT' }),
      workflow: 'OWNER_AUTOPILOT',
    });
    expect(prompt).toContain('This request is from the owner. Execute directly');
  });

  it('always enforces plain wording', () => {
    const prompt = buildMentionSystemPrompt({
      task: makeTask(),
      workflow: 'UNKNOWN',
    });
    expect(prompt).toContain('Use plain, natural wording.');
    expect(prompt).toContain('No jokes, sarcasm, playful metaphors, or themed tone.');
    expect(prompt).toContain('Do not force technical framing for non-technical prompts.');
  });

  it('labels admin non-owner requests correctly', () => {
    const prompt = buildMentionSystemPrompt({
      task: makeTask({ isOwnerAuthor: false, isCoreDevAuthor: true, intent: 'IMPLEMENTATION' }),
      workflow: 'IMPLEMENTATION',
    });
    expect(prompt).toContain('admin');
    expect(prompt).not.toContain('This request is from the owner');
  });

  it('forces serious tone instructions for PR-thread context', () => {
    const prompt = buildMentionSystemPrompt({
      task: makeTask({
        prContext: {
          url: 'https://github.com/Newton-School/newton-web/pull/7724',
          owner: 'Newton-School',
          repo: 'newton-web',
          number: 7724,
        },
      }),
      workflow: 'UNKNOWN',
    });
    expect(prompt).toContain('This is a serious work context. Keep the reply especially direct and unembellished.');
  });

  describe('role-aware explanation guidance', () => {
    it.each(['CONVERSATIONAL', 'INFORMATIONAL', 'INVESTIGATION'] as const)(
      'adds the explanation-first baseline for %s replies',
      workflow => {
        const prompt = buildMentionSystemPrompt({ task: makeTask(), workflow });
        expect(prompt).toContain('Lead with the explanation.');
        expect(prompt).not.toContain('not an engineer');
      },
    );

    it.each(['IMPLEMENTATION', 'PR_REVIEW', 'DEPLOY', 'OWNER_AUTOPILOT', 'UNKNOWN'] as const)(
      'does not emit the explanation-first baseline for %s',
      workflow => {
        const prompt = buildMentionSystemPrompt({
          task: makeTask(),
          workflow,
          dossierRole: 'pm',
        });
        expect(prompt).not.toContain('Lead with the explanation.');
        expect(prompt).not.toContain('not an engineer');
      },
    );

    it('layers non-dev guidance on top for PMs in a conversational reply', () => {
      const prompt = buildMentionSystemPrompt({
        task: makeTask(),
        workflow: 'CONVERSATIONAL',
        dossierRole: 'pm',
      });
      expect(prompt).toContain('Lead with the explanation.');
      expect(prompt).toContain('asker is a pm — not an engineer');
    });

    it('layers non-dev guidance on informational replies too', () => {
      const prompt = buildMentionSystemPrompt({
        task: makeTask(),
        workflow: 'INFORMATIONAL',
        dossierRole: 'designer',
      });
      expect(prompt).toContain('asker is a designer — not an engineer');
    });

    it('treats designer and ops as non-dev', () => {
      const designer = buildMentionSystemPrompt({
        task: makeTask(),
        workflow: 'CONVERSATIONAL',
        dossierRole: 'designer',
      });
      expect(designer).toContain('asker is a designer — not an engineer');

      const ops = buildMentionSystemPrompt({
        task: makeTask(),
        workflow: 'CONVERSATIONAL',
        dossierRole: 'ops',
      });
      expect(ops).toContain('asker is a ops — not an engineer');
    });

    it('does not emit non-dev guidance for dev role', () => {
      const prompt = buildMentionSystemPrompt({
        task: makeTask(),
        workflow: 'CONVERSATIONAL',
        dossierRole: 'dev',
      });
      expect(prompt).toContain('Lead with the explanation.');
      expect(prompt).not.toContain('not an engineer');
    });

    it.each(['CONVERSATIONAL', 'INFORMATIONAL', 'INVESTIGATION'] as const)(
      'adds analyst guidance for %s replies',
      workflow => {
        const prompt = buildMentionSystemPrompt({
          task: makeTask(),
          workflow,
          dossierRole: 'analyst',
        });
        expect(prompt).toContain('asker is a business analyst');
        expect(prompt).toContain('Postgres');
        expect(prompt).toContain('newton-api');
        expect(prompt).not.toContain('not an engineer');
      },
    );

    it('does not emit analyst guidance on non-explanation workflows', () => {
      const prompt = buildMentionSystemPrompt({
        task: makeTask(),
        workflow: 'IMPLEMENTATION',
        dossierRole: 'analyst',
      });
      expect(prompt).not.toContain('asker is a business analyst');
    });
  });
});
