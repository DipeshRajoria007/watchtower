import { describe, expect, it } from 'vitest';
import { parseCodexStructuredOutput } from '../src/codex/runCodex.js';

describe('runCodex structured output parsing', () => {
  it('parses direct JSON object output', () => {
    const parsed = parseCodexStructuredOutput(
      JSON.stringify({ status: 'success', summary: 'done', actions: [], prUrl: '' }),
    );

    expect(parsed.strategy).toBe('direct');
    expect(parsed.parsedJson?.status).toBe('success');
  });

  it('salvages JSON from fenced blocks', () => {
    const parsed = parseCodexStructuredOutput(
      'Here is the result:\n```json\n{"status":"success","summary":"fenced","actions":[],"prUrl":""}\n```',
    );

    expect(parsed.strategy).toBe('fenced_block');
    expect(parsed.parsedJson?.summary).toBe('fenced');
  });

  it('salvages first top-level object from mixed text', () => {
    const parsed = parseCodexStructuredOutput(
      'Completed execution. payload={"status":"success","summary":"mixed","actions":[],"prUrl":""} end.',
    );

    expect(parsed.strategy).toBe('first_object');
    expect(parsed.parsedJson?.summary).toBe('mixed');
  });

  it('reports attempts when parsing fails', () => {
    const parsed = parseCodexStructuredOutput('not json at all');

    expect(parsed.parsedJson).toBeUndefined();
    expect(parsed.attempts).toEqual(['direct', 'fenced_block', 'first_object']);
  });
});
