import { describe, expect, it } from 'vitest';
import { parseMiniogSubcommand } from '../src/router/intentParser.js';

describe('parseMiniogSubcommand', () => {
  it('parses whoami', () => {
    expect(parseMiniogSubcommand('whoami')).toEqual({ kind: 'whoami' });
    expect(parseMiniogSubcommand('<@UBOT1> whoami')).toEqual({ kind: 'whoami' });
    expect(parseMiniogSubcommand('  WhoAmI  ')).toEqual({ kind: 'whoami' });
  });

  it('parses set-role with valid roles', () => {
    expect(parseMiniogSubcommand('set-role pm')).toEqual({ kind: 'set-role', role: 'pm' });
    expect(parseMiniogSubcommand('<@UBOT1> set-role dev')).toEqual({ kind: 'set-role', role: 'dev' });
    expect(parseMiniogSubcommand('set-role designer')).toEqual({ kind: 'set-role', role: 'designer' });
    expect(parseMiniogSubcommand('set-role ops')).toEqual({ kind: 'set-role', role: 'ops' });
  });

  it('rejects set-role with invalid role', () => {
    expect(parseMiniogSubcommand('set-role wizard')).toBeNull();
    expect(parseMiniogSubcommand('set-role')).toBeNull();
  });

  it('parses forget for individual fields with implicit confirm', () => {
    expect(parseMiniogSubcommand('forget role')).toEqual({ kind: 'forget', field: 'role', confirmed: true });
    expect(parseMiniogSubcommand('forget tone')).toEqual({ kind: 'forget', field: 'tone', confirmed: true });
    expect(parseMiniogSubcommand('forget project_affinity')).toEqual({
      kind: 'forget',
      field: 'project_affinity',
      confirmed: true,
    });
  });

  it('requires explicit confirmation for forget all', () => {
    expect(parseMiniogSubcommand('forget all')).toEqual({ kind: 'forget', field: 'all', confirmed: false });
    expect(parseMiniogSubcommand('forget all confirm')).toEqual({ kind: 'forget', field: 'all', confirmed: true });
  });

  it('rejects unknown forget fields', () => {
    expect(parseMiniogSubcommand('forget password')).toBeNull();
    expect(parseMiniogSubcommand('forget')).toBeNull();
  });

  it('returns null for unrelated text', () => {
    expect(parseMiniogSubcommand('')).toBeNull();
    expect(parseMiniogSubcommand('hello miniog')).toBeNull();
    expect(parseMiniogSubcommand('please review this PR')).toBeNull();
  });
});
