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
    intent: 'UNKNOWN',
    ...overrides,
  };
}

describe('mentionSystemPrompt', () => {
  it('includes owner execution rule for owner-authored mentions', () => {
    const prompt = buildMentionSystemPrompt({
      task: makeTask({ isOwnerAuthor: true, intent: 'OWNER_AUTOPILOT' }),
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
});
