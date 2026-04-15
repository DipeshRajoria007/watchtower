import { describe, expect, it } from 'vitest';
import { computeCostUsd, getModelPricing } from '../src/pricing/modelPrices.js';

describe('modelPrices.computeCostUsd', () => {
  it('returns undefined for unknown model', () => {
    const cost = computeCostUsd({ inputTokens: 1000, outputTokens: 500 }, 'no-such-model');
    expect(cost).toBeUndefined();
  });

  it('returns undefined when usage is undefined', () => {
    const cost = computeCostUsd(undefined, 'claude-sonnet-4-20250514');
    expect(cost).toBeUndefined();
  });

  it('computes cost for sonnet using input + output rates', () => {
    const pricing = getModelPricing('claude-sonnet-4-20250514');
    expect(pricing).toBeDefined();
    const cost = computeCostUsd({ inputTokens: 1000, outputTokens: 1000 }, 'claude-sonnet-4-20250514');
    // input $0.003 + output $0.015 = $0.018 per 1K tokens of each
    expect(cost).toBeCloseTo(0.003 + 0.015, 6);
  });

  it('includes cache read and cache creation when present', () => {
    const cost = computeCostUsd(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1000,
        cacheCreationTokens: 1000,
      },
      'claude-opus-4-20250514',
    );
    // opus cacheRead $0.0015 + cacheCreate $0.01875 per 1K
    expect(cost).toBeCloseTo(0.0015 + 0.01875, 6);
  });

  it('treats missing token fields as zero', () => {
    const cost = computeCostUsd({ inputTokens: 2000 }, 'gpt-5.4');
    // gpt-5.4 input $0.015 per 1K, 2K tokens → $0.03
    expect(cost).toBeCloseTo(0.03, 6);
  });
});
