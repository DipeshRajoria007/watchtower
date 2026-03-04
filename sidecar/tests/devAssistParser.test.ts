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

  it('parses wt runs command with optional limit', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt runs')).toEqual({ type: 'RUNS', limit: 5 });
    expect(parseDevAssistCommand('<@UBOT1> wt runs 8')).toEqual({ type: 'RUNS', limit: 8 });
  });

  it('parses wt failures command with optional limit', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt failures')).toEqual({ type: 'FAILURES', limit: 5 });
    expect(parseDevAssistCommand('<@UBOT1> wt failures 9')).toEqual({ type: 'FAILURES', limit: 9 });
  });

  it('parses wt trace command with optional lines', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt trace abc123')).toEqual({
      type: 'TRACE',
      jobId: 'abc123',
      limit: 20,
    });
    expect(parseDevAssistCommand('<@UBOT1> wt trace abc123 40')).toEqual({
      type: 'TRACE',
      jobId: 'abc123',
      limit: 40,
    });
  });

  it('parses wt diagnose command', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt diagnose abc123')).toEqual({
      type: 'DIAGNOSE',
      jobId: 'abc123',
    });
  });

  it('parses wt learn command', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt learn')).toEqual({
      type: 'LEARN',
    });
  });

  it('parses wt heat command with optional limit', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt heat')).toEqual({
      type: 'HEAT',
      limit: 5,
    });
    expect(parseDevAssistCommand('<@UBOT1> wt heat 7')).toEqual({
      type: 'HEAT',
      limit: 7,
    });
  });

  it('parses wt personality set command', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt personality set friendly me')).toEqual({
      type: 'PERSONALITY_SET',
      mode: 'friendly',
      scope: 'user',
    });
    expect(parseDevAssistCommand('<@UBOT1> wt personality set chaos channel')).toEqual({
      type: 'PERSONALITY_SET',
      mode: 'chaos',
      scope: 'channel',
    });
  });

  it('parses wt personality show command', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt personality show')).toEqual({
      type: 'PERSONALITY_SHOW',
      scope: 'user',
    });
    expect(parseDevAssistCommand('<@UBOT1> wt personality show channel')).toEqual({
      type: 'PERSONALITY_SHOW',
      scope: 'channel',
    });
  });

  it('parses wt mission commands', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt mission start stabilize checkout latency')).toEqual({
      type: 'MISSION_START',
      goal: 'stabilize checkout latency',
    });
    expect(parseDevAssistCommand('<@UBOT1> wt mission show')).toEqual({
      type: 'MISSION_SHOW',
    });
  });

  it('detects dev-assist prefix only when present', () => {
    expect(hasDevAssistCommand('<@UBOT1> wt help')).toBe(true);
    expect(hasDevAssistCommand('<@UBOT1> please review this PR')).toBe(false);
  });
});
