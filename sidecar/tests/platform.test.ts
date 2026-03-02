import { describe, expect, it } from 'vitest';
import { assertMacOS } from '../src/platform.js';

describe('platform guard', () => {
  it('allows darwin', () => {
    expect(() => assertMacOS('darwin')).not.toThrow();
  });

  it('rejects non-darwin', () => {
    expect(() => assertMacOS('linux')).toThrow('macOS-only');
  });
});
