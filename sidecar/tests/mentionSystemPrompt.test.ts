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

  it('includes personality mode when provided', () => {
    const prompt = buildMentionSystemPrompt({
      task: makeTask(),
      workflow: 'UNKNOWN',
      personalityMode: 'dark_humor',
    });
    expect(prompt).toContain('Reply personality mode: dark_humor');
    expect(prompt).toContain('Use short corporate-style humor when it fits the context.');
    expect(prompt).toContain('Do not force technical framing for non-technical prompts.');
  });
});
