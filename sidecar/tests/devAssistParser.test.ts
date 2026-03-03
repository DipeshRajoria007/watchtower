import { describe, expect, it } from 'vitest';
import { hasDevAssistCommand, parseDevAssistCommand } from '../src/router/devAssistParser.js';

describe('devAssistParser', () => {
  it('parses wt help commands', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt help')).toEqual({ type: 'HELP' });
    expect(parseDevAssistCommand('<@UBOT1> watchtower help')).toEqual({ type: 'HELP' });
    expect(parseDevAssistCommand('<@UBOT1> wt')).toEqual({ type: 'HELP' });
  });

  it('parses wt status command', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt status')).toEqual({ type: 'STATUS' });
  });

  it('detects dev-assist prefix only when present', () => {
    expect(hasDevAssistCommand('<@UBOT1> wt help')).toBe(true);
    expect(hasDevAssistCommand('<@UBOT1> please review this PR')).toBe(false);
  });
});
