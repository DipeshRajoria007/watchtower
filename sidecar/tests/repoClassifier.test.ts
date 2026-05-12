/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn(() => 'claude-code'),
}));
vi.mock('../src/codex/modelProfiles.js', () => ({
  lightweightProfile: vi.fn(() => ({ model: 'haiku-test', reasoningEffort: 'low' })),
}));

const { runCodex } = await import('../src/codex/runCodex.js');
const { classifyRepo } = await import('../src/router/repoClassifier.js');

function aiReply(parsedJson: Record<string, unknown>): any {
  return { ok: true, exitCode: 0, parsedJson };
}

describe('classifyRepo (agent-based)', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
  });

  it('returns the agent-selected repo when confidence clears the threshold', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ selectedRepo: 'newton-web', confidence: 0.9, reasoning: 'nav bar removal on my.newtonschool.co URL' }),
    );
    const out = await classifyRepo({
      task: 'remove the whatsapp section in the right nav bar on my.newtonschool.co/tech-openings/all-jobs',
      threshold: 0.75,
    });
    expect(out.selectedRepo).toBe('newton-web');
    expect(out.uncertain).toBe(false);
    expect(out.confidence).toBe(0.9);
  });

  it('returns newton-api when the agent says so', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ selectedRepo: 'newton-api', confidence: 0.88, reasoning: 'django endpoint 500' }),
    );
    const out = await classifyRepo({
      task: 'the /api/v1/users endpoint returns 500 with a Django traceback',
      threshold: 0.75,
    });
    expect(out.selectedRepo).toBe('newton-api');
    expect(out.uncertain).toBe(false);
  });

  it('marks uncertain when confidence is below threshold', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ selectedRepo: 'newton-web', confidence: 0.4, reasoning: 'thin signal' }),
    );
    const out = await classifyRepo({ task: 'something might be broken', threshold: 0.75 });
    expect(out.uncertain).toBe(true);
  });

  it('marks uncertain when the agent returns null', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(aiReply({ selectedRepo: null, confidence: 0.2, reasoning: 'no signal' }));
    const out = await classifyRepo({ task: 'hey', threshold: 0.75 });
    expect(out.selectedRepo).toBeNull();
    expect(out.uncertain).toBe(true);
  });

  it('falls back to uncertain when the agent call fails', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({ ok: false, exitCode: 1 } as any);
    const out = await classifyRepo({ task: 'anything', threshold: 0.75 });
    expect(out.uncertain).toBe(true);
    expect(out.selectedRepo).toBeNull();
  });

  it('does not call the agent when there is no task text', async () => {
    const out = await classifyRepo({ task: '   ', threadMessages: ['some thread chatter'], threshold: 0.75 });
    expect(out.uncertain).toBe(true);
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('labels task and thread separately in the prompt so the agent weights them correctly', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ selectedRepo: 'newton-web', confidence: 0.9, reasoning: 'frontend' }),
    );
    await classifyRepo({
      task: 'remove the blue banner',
      threadMessages: ['earlier we discussed an api 500'],
      threshold: 0.75,
    });
    const args = vi.mocked(runCodex).mock.calls[0][0];
    expect(args.prompt).toContain('Current task (the message to classify)');
    expect(args.prompt).toContain('Earlier thread messages (advisory background');
    expect(args.prompt).toContain('remove the blue banner');
    expect(args.prompt).toContain('earlier we discussed an api 500');
    // The task block must precede the thread block so the agent reads it first.
    expect(args.prompt.indexOf('remove the blue banner')).toBeLessThan(
      args.prompt.indexOf('earlier we discussed an api 500'),
    );
  });

  it('passes affinity and plan hints to the agent prompt as advisory context', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(
      aiReply({ selectedRepo: 'newton-api', confidence: 0.9, reasoning: 'planner hints + affinity' }),
    );
    await classifyRepo({
      task: 'fix the thing',
      threshold: 0.75,
      affinity: { newtonWebHits: 1, newtonApiHits: 20 },
      planAffectedFiles: ['handlers/create.py'],
    });
    const args = vi.mocked(runCodex).mock.calls[0][0];
    expect(args.prompt).toContain('newton-api=20 hits');
    expect(args.prompt).toContain('handlers/create.py');
  });
});
