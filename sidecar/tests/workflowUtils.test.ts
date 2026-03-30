import { describe, expect, it } from 'vitest';
import {
  formatThreadContext,
  stripMentions,
  isPresencePing,
  buildPresenceReply,
  sanitizeOwnerSummary,
} from '../src/workflows/shared/workflowUtils.js';
import type { NormalizedTask } from '../src/types/contracts.js';

const baseTask: NormalizedTask = {
  event: {
    eventId: 'Ev1',
    channelId: 'C01',
    threadTs: '111.22',
    eventTs: '111.22',
    userId: 'U123',
    text: 'hello world',
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  isCoreDevAuthor: false,
  intent: 'IMPLEMENTATION',
};

describe('formatThreadContext', () => {
  it('formats root message and thread replies', () => {
    const result = formatThreadContext(baseTask, [
      { text: 'reply 1', user: 'U456', ts: '111.33' },
      { text: 'reply 2', user: 'U789', ts: '111.44' },
    ]);
    expect(result).toContain('[root] user=U123');
    expect(result).toContain('hello world');
    expect(result).toContain('[thread] user=U456');
    expect(result).toContain('reply 1');
    expect(result).toContain('reply 2');
  });

  it('handles empty thread', () => {
    const result = formatThreadContext(baseTask, []);
    expect(result).toContain('hello world');
    expect(result).not.toContain('[thread]');
  });
});

describe('stripMentions', () => {
  it('removes mention markup', () => {
    expect(stripMentions('<@U123> hello <@U456>')).toBe('hello');
  });

  it('collapses whitespace', () => {
    expect(stripMentions('  hello   world  ')).toBe('hello world');
  });
});

describe('isPresencePing', () => {
  it.each(['hi', 'hello', 'hey', 'yo', 'ping', 'you there', 'are you there', 'online', 'awake', 'alive'])(
    'matches "%s"',
    text => {
      expect(isPresencePing(text)).toBe(true);
    },
  );

  it('matches with punctuation', () => {
    expect(isPresencePing('you there?')).toBe(true);
    expect(isPresencePing('hello!')).toBe(true);
  });

  it('matches empty string', () => {
    expect(isPresencePing('')).toBe(true);
  });

  it('does NOT match longer messages', () => {
    expect(isPresencePing('hi can you add dark mode')).toBe(false);
    expect(isPresencePing('hello review this PR')).toBe(false);
    expect(isPresencePing('ping the team about the deployment')).toBe(false);
  });
});

describe('buildPresenceReply', () => {
  it('returns a deterministic reply based on eventTs', () => {
    const reply1 = buildPresenceReply('111.22');
    const reply2 = buildPresenceReply('111.22');
    expect(reply1).toBe(reply2);
  });

  it('returns different replies for different timestamps', () => {
    const replies = new Set([buildPresenceReply('111.22'), buildPresenceReply('222.33'), buildPresenceReply('333.44')]);
    // At least 2 different replies across 3 timestamps
    expect(replies.size).toBeGreaterThanOrEqual(2);
  });
});

describe('sanitizeOwnerSummary', () => {
  it('strips "On Master\'s command" prefix', () => {
    expect(sanitizeOwnerSummary("On master's command, overriding watchtower guardrails. Done.")).toBe('Done.');
  });

  it('strips "Owner request success" prefix', () => {
    expect(sanitizeOwnerSummary('Owner request success. Merged the PR.')).toBe('Merged the PR.');
  });

  it('strips action audit blocks', () => {
    expect(sanitizeOwnerSummary('Created the file.\nActions:\n- posted in slack\n- confirmed slack thread')).toBe(
      'Created the file.',
    );
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeOwnerSummary('')).toBe('');
    expect(sanitizeOwnerSummary('  ')).toBe('');
  });

  it('strips telemetry references', () => {
    const result = sanitizeOwnerSummary('Done. Posted in slack thread 123.456 channel C01H25RNLJH timestamp 123.456');
    // Telemetry lines are stripped, only non-telemetry content remains
    expect(result).not.toContain('slack thread');
    expect(result).not.toContain('C01H25RNLJH');
    expect(result).not.toContain('timestamp');
  });
});
