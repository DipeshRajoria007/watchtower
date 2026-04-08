import { describe, expect, it, beforeEach } from 'vitest';
import { registerActiveJob, unregisterActiveJob, cancelJob, getActiveJobIds } from '../src/state/activeJobs.js';

describe('activeJobs', () => {
  beforeEach(() => {
    // Clean up any stale entries
    for (const id of getActiveJobIds()) {
      unregisterActiveJob(id);
    }
  });

  it('registers and lists active jobs', () => {
    const controller = new AbortController();
    registerActiveJob('job-1', controller);
    expect(getActiveJobIds()).toEqual(['job-1']);
  });

  it('unregisters a job', () => {
    const controller = new AbortController();
    registerActiveJob('job-2', controller);
    unregisterActiveJob('job-2');
    expect(getActiveJobIds()).toEqual([]);
  });

  it('cancels a job by exact id', () => {
    const controller = new AbortController();
    registerActiveJob('abcdef-1234', controller);

    const result = cancelJob('abcdef-1234');
    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(getActiveJobIds()).toEqual([]);
  });

  it('cancels a job by prefix match', () => {
    const controller = new AbortController();
    registerActiveJob('abcdef-1234-5678', controller);

    const result = cancelJob('abcdef');
    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(getActiveJobIds()).toEqual([]);
  });

  it('returns false when no job matches', () => {
    const result = cancelJob('nonexistent');
    expect(result).toBe(false);
  });
});
