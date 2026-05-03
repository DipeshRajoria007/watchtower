import { describe, expect, it } from 'vitest';
import { classifyProduct, productDisplayName, PRODUCT_RULES } from '../src/router/productClassifier.js';

describe('classifyProduct — keyword resolution', () => {
  it('matches NSAT timeline by primary keyword', () => {
    const r = classifyProduct(['fix the nsat timeline rendering bug']);
    expect(r.selected).toBe('nsat-timeline');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('matches JEE rank predictor by either keyword', () => {
    expect(classifyProduct(['rank predictor showing wrong rank']).selected).toBe('jee-rank-predictor');
    expect(classifyProduct(['jee rank computation off']).selected).toBe('jee-rank-predictor');
  });

  it('matches NST Samurai', () => {
    expect(classifyProduct(['samurai assessment broken']).selected).toBe('nst-samurai');
  });

  it('matches Newton Box across spelling variants', () => {
    expect(classifyProduct(['newton-box layout']).selected).toBe('newton-box');
    expect(classifyProduct(['newtonbox 404']).selected).toBe('newton-box');
  });

  it('matches Playgrounds', () => {
    expect(classifyProduct(['playgrounds page broken']).selected).toBe('playgrounds');
  });

  it('returns null when no rule matches', () => {
    expect(classifyProduct(['just a general dashboard fix']).selected).toBeNull();
    expect(classifyProduct(['']).selected).toBeNull();
    expect(classifyProduct([]).selected).toBeNull();
  });

  it('case-insensitive', () => {
    expect(classifyProduct(['NSAT TIMELINE breaking']).selected).toBe('nsat-timeline');
    expect(classifyProduct(['Newton Box panic']).selected).toBe('newton-box');
  });

  it('considers multiple texts together', () => {
    const r = classifyProduct(['user asked about the assignment', 'investigation note: nsat sidebar']);
    expect(r.selected).toBe('nsat-timeline');
  });

  it('emits matched signal names for log readability', () => {
    const r = classifyProduct(['nsat timeline crash']);
    expect(r.signals.length).toBeGreaterThan(0);
    expect(r.signals[0]).toMatch(/^nsat-timeline:/);
  });
});

describe('productDisplayName', () => {
  it('returns the human label for known keys', () => {
    expect(productDisplayName('nsat-timeline')).toBe('NSAT timeline');
    expect(productDisplayName('jee-rank-predictor')).toBe('JEE rank predictor');
  });

  it('falls back to the raw key for unknown values', () => {
    expect(productDisplayName('something-new')).toBe('something-new');
  });
});

describe('PRODUCT_RULES catalogue', () => {
  it('has unique keys', () => {
    const keys = PRODUCT_RULES.map(r => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('all rules have at least one pattern', () => {
    for (const rule of PRODUCT_RULES) {
      expect(rule.patterns.length).toBeGreaterThan(0);
    }
  });
});
