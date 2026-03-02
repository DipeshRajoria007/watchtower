import { describe, expect, it } from 'vitest';
import { classifyRepo } from '../src/router/repoClassifier.js';

describe('repoClassifier', () => {
  it('prefers newton-web for UI signals', () => {
    const result = classifyRepo(['React component broken in frontend page'], 0.75);
    expect(result.selectedRepo).toBe('newton-web');
    expect(result.uncertain).toBe(false);
  });

  it('prefers newton-api for backend signals', () => {
    const result = classifyRepo(['django endpoint returns 500 traceback'], 0.75);
    expect(result.selectedRepo).toBe('newton-api');
    expect(result.uncertain).toBe(false);
  });

  it('marks uncertain when confidence below threshold', () => {
    const result = classifyRepo(['bug in ui and api endpoint both failing'], 0.95);
    expect(result.uncertain).toBe(true);
  });
});
