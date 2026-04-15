import { describe, expect, it } from 'vitest';
import { claudeCodeBackend } from '../src/backends/claudeCodeBackend.js';

describe('claudeCodeBackend.parseOutput', () => {
  it('unwraps Claude Code wrapper and extracts inner structured JSON', () => {
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: JSON.stringify({
        status: 'success',
        summary: 'Merged PR #7638 into master.',
        actions: ['Merged PR'],
        prUrl: 'https://github.com/org/repo/pull/7638',
      }),
      session_id: 'abc-123',
      cost_usd: 0.05,
    });

    const parsed = claudeCodeBackend.parseOutput(wrapper);
    expect(parsed.parsedJson?.status).toBe('success');
    expect(parsed.parsedJson?.summary).toBe('Merged PR #7638 into master.');
    expect(parsed.parsedJson?.prUrl).toBe('https://github.com/org/repo/pull/7638');
    expect(parsed.strategy).toContain('claude_unwrap');
  });

  it('unwraps Claude Code wrapper with plain text result into synthetic summary', () => {
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: "Yes, I'm here! How can I help you?",
      session_id: 'abc-456',
      cost_usd: 0.01,
    });

    const parsed = claudeCodeBackend.parseOutput(wrapper);
    expect(parsed.parsedJson?.status).toBe('success');
    expect(parsed.parsedJson?.summary).toBe("Yes, I'm here! How can I help you?");
    expect(parsed.strategy).toBe('claude_unwrap+plain_text');
  });

  it('handles inner JSON wrapped in markdown fences', () => {
    const innerJson = '```json\n{"status":"success","summary":"Done fixing.","actions":["fixed"],"prUrl":""}\n```';
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: innerJson,
      session_id: 'abc-789',
    });

    const parsed = claudeCodeBackend.parseOutput(wrapper);
    expect(parsed.parsedJson?.status).toBe('success');
    expect(parsed.parsedJson?.summary).toBe('Done fixing.');
    expect(parsed.strategy).toBe('claude_unwrap+fenced_block');
  });

  it('falls back to direct parsing when output is not a Claude Code wrapper', () => {
    const raw = JSON.stringify({
      status: 'success',
      summary: 'Direct JSON output.',
      actions: [],
      prUrl: '',
    });

    const parsed = claudeCodeBackend.parseOutput(raw);
    expect(parsed.parsedJson?.status).toBe('success');
    expect(parsed.parsedJson?.summary).toBe('Direct JSON output.');
    expect(parsed.strategy).toBe('direct');
  });

  it('extracts cost_usd and usage tokens from the outer envelope', () => {
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Plain reply.',
      session_id: 'sess-1',
      cost_usd: 0.0123,
      usage: {
        input_tokens: 1500,
        output_tokens: 320,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 800,
      },
    });

    const parsed = claudeCodeBackend.parseOutput(wrapper);
    expect(parsed.costUsd).toBe(0.0123);
    expect(parsed.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 320,
      cacheCreationTokens: 200,
      cacheReadTokens: 800,
    });
  });

  it('returns undefined usage when envelope has no usage block', () => {
    const wrapper = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'no usage info here',
      session_id: 'sess-2',
    });
    const parsed = claudeCodeBackend.parseOutput(wrapper);
    expect(parsed.usage).toBeUndefined();
    expect(parsed.costUsd).toBeUndefined();
  });
});
