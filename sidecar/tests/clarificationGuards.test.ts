import { describe, expect, it } from 'vitest';
import { detectClarificationLoop, isCancelReply } from '../src/workflows/shared/clarificationGuards.js';

describe('isCancelReply', () => {
  it('matches plain cancel words', () => {
    expect(isCancelReply('cancel')).toBe(true);
    expect(isCancelReply('stop')).toBe(true);
    expect(isCancelReply('abort')).toBe(true);
    expect(isCancelReply('nevermind')).toBe(true);
    expect(isCancelReply('Skip')).toBe(true);
  });

  it('handles Slack footer appended by forwarded apps', () => {
    expect(isCancelReply('cancel *Sent using* <@U123ABC>')).toBe(true);
    expect(isCancelReply('stop\n*Sent using* <@U0ACB8RHKED>')).toBe(true);
  });

  it('matches when cancel is the first token', () => {
    expect(isCancelReply('cancel please')).toBe(true);
    expect(isCancelReply("abort, let's rethink")).toBe(true);
  });

  it('does not match when the intent is not cancel', () => {
    expect(isCancelReply('please continue')).toBe(false);
    expect(isCancelReply('')).toBe(false);
    expect(isCancelReply('fix the bug first')).toBe(false);
    expect(isCancelReply('i said cancel yesterday')).toBe(false);
  });
});

describe('detectClarificationLoop', () => {
  it('returns not-looping when history is empty', () => {
    expect(detectClarificationLoop([], 'What error do you see?')).toEqual({ looping: false });
  });

  it('detects a near-identical repeat question', () => {
    const result = detectClarificationLoop(
      [{ question: 'What error do you see in the console?', answer: 'idk' }],
      'What error do you see in the console?',
    );
    expect(result.looping).toBe(true);
  });

  it('does not flag a genuinely different follow-up question', () => {
    const result = detectClarificationLoop(
      [{ question: 'What is the console error?', answer: 'TypeError: x is undefined' }],
      'Which component owns the state for the Add Company modal?',
    );
    expect(result.looping).toBe(false);
  });

  it('flags two consecutive short/unhelpful answers', () => {
    const result = detectClarificationLoop(
      [
        { question: 'What error?', answer: 'idk' },
        { question: 'Which file?', answer: 'you decide' },
      ],
      'Which component is failing?',
    );
    expect(result.looping).toBe(true);
  });

  it('does not flag a single short answer', () => {
    const result = detectClarificationLoop(
      [{ question: 'What error?', answer: 'idk' }],
      'Which network request fails?',
    );
    expect(result.looping).toBe(false);
  });

  it('ignores slack footer when comparing answers', () => {
    const result = detectClarificationLoop(
      [
        { question: 'What error?', answer: 'idk *Sent using* <@U0ACB8RHKED>' },
        { question: 'Which file?', answer: 'whatever *Sent using* <@U0ACB8RHKED>' },
      ],
      'Which component is failing?',
    );
    expect(result.looping).toBe(true);
  });
});
