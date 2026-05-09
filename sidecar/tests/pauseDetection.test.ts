import { describe, expect, it } from 'vitest';
import { isQuickPauseMessage } from '../src/agents/pipeline.js';
import { isPauseReply } from '../src/workflows/shared/clarificationGuards.js';

describe('isQuickPauseMessage', () => {
  it('matches plain pause words', () => {
    expect(isQuickPauseMessage('wait')).toBe(true);
    expect(isQuickPauseMessage('Wait')).toBe(true);
    expect(isQuickPauseMessage('hold on')).toBe(true);
    expect(isQuickPauseMessage('hold up')).toBe(true);
    expect(isQuickPauseMessage('pause')).toBe(true);
    expect(isQuickPauseMessage('one sec')).toBe(true);
    expect(isQuickPauseMessage('one moment')).toBe(true);
    expect(isQuickPauseMessage('stand by')).toBe(true);
    expect(isQuickPauseMessage("I'll get back to you")).toBe(true);
    expect(isQuickPauseMessage('Ill get back to you')).toBe(true);
    expect(isQuickPauseMessage('give me a sec')).toBe(true);
    expect(isQuickPauseMessage('gimme a sec')).toBe(true);
    expect(isQuickPauseMessage('give me a minute')).toBe(true);
    expect(isQuickPauseMessage('give me a moment')).toBe(true);
    expect(isQuickPauseMessage('pause for now')).toBe(true);
    expect(isQuickPauseMessage('stop for now')).toBe(true);
  });

  it('tolerates trailing punctuation/whitespace', () => {
    expect(isQuickPauseMessage('wait!')).toBe(true);
    expect(isQuickPauseMessage('wait.')).toBe(true);
    expect(isQuickPauseMessage('  pause  ')).toBe(true);
    expect(isQuickPauseMessage('one sec...')).toBe(true);
  });

  it('does NOT match "wait" used as filler before real instructions', () => {
    // These must classify as feedback, not pause — the user is still actively giving direction.
    expect(isQuickPauseMessage("wait, that's wrong")).toBe(false);
    expect(isQuickPauseMessage('wait, also include X')).toBe(false);
    expect(isQuickPauseMessage('wait — let me explain')).toBe(false);
    expect(isQuickPauseMessage('hold on, the API name is different')).toBe(false);
    expect(isQuickPauseMessage('pause and check this file first')).toBe(false);
  });

  it('does not match unrelated messages', () => {
    expect(isQuickPauseMessage('')).toBe(false);
    expect(isQuickPauseMessage('go ahead')).toBe(false);
    expect(isQuickPauseMessage('yes')).toBe(false);
    expect(isQuickPauseMessage('no')).toBe(false);
    expect(isQuickPauseMessage('ship it')).toBe(false);
    expect(isQuickPauseMessage('fix the auth bug first')).toBe(false);
  });
});

describe('isPauseReply (clarificationGuards)', () => {
  it('matches the same patterns as the pipeline regex', () => {
    expect(isPauseReply('wait')).toBe(true);
    expect(isPauseReply('hold on')).toBe(true);
    expect(isPauseReply('pause')).toBe(true);
  });

  it('tolerates Slack mention footers ("*Sent using* <@U…>")', () => {
    expect(isPauseReply('wait *Sent using* <@U123ABC>')).toBe(true);
    expect(isPauseReply('pause\n*Sent using* <@U0ACB8RHKED>')).toBe(true);
  });

  it('strips @mentions before matching so "<@miniOG> wait" still pauses', () => {
    expect(isPauseReply('<@U0AG8P9B3FW> wait')).toBe(true);
    expect(isPauseReply('<@U0AG8P9B3FW|miniOG> hold on')).toBe(true);
  });

  it('does not match feedback that starts with "wait,"', () => {
    expect(isPauseReply("wait, that's wrong")).toBe(false);
    expect(isPauseReply('wait, also include X')).toBe(false);
  });

  it('does not match empty / unrelated', () => {
    expect(isPauseReply('')).toBe(false);
    expect(isPauseReply('lgtm')).toBe(false);
  });
});
