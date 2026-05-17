import { describe, expect, it, vi, beforeEach } from 'vitest';
import { classifyWorkflowIntent } from '../src/router/classifyIntent.js';
import { runCodex } from '../src/codex/runCodex.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

function mockClassification(intent: string, confidence = 0.9) {
  vi.mocked(runCodex).mockResolvedValueOnce({
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: '',
    stderr: '',
    lastMessage: '',
    parsedJson: { intent, confidence, reasoning: `classified as ${intent}` },
  });
}

describe('classifyWorkflowIntent', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
  });

  it('returns IMPLEMENTATION for action requests', async () => {
    mockClassification('IMPLEMENTATION');
    const result = await classifyWorkflowIntent({ userMessage: 'add dark mode to login page', hasPrUrl: false });
    expect(result.intent).toBe('IMPLEMENTATION');
    expect(result.confidence).toBe(0.9);
  });

  it('returns INFORMATIONAL for questions', async () => {
    mockClassification('INFORMATIONAL');
    const result = await classifyWorkflowIntent({ userMessage: 'how does the auth flow work?', hasPrUrl: false });
    expect(result.intent).toBe('INFORMATIONAL');
  });

  it('returns INVESTIGATION when the classifier picks it for a vague bug report', async () => {
    mockClassification('INVESTIGATION');
    const result = await classifyWorkflowIntent({
      userMessage: 'check what is happening with the placement dashboard, something is off',
      hasPrUrl: false,
    });
    expect(result.intent).toBe('INVESTIGATION');
  });

  it('returns CONVERSATIONAL for greetings', async () => {
    mockClassification('CONVERSATIONAL');
    const result = await classifyWorkflowIntent({ userMessage: 'hey, how are you?', hasPrUrl: false });
    expect(result.intent).toBe('CONVERSATIONAL');
  });

  it('returns PR_REVIEW when PR URL present and review requested', async () => {
    mockClassification('PR_REVIEW');
    const result = await classifyWorkflowIntent({
      userMessage: 'review https://github.com/Newton-School/newton-web/pull/123',
      hasPrUrl: true,
    });
    expect(result.intent).toBe('PR_REVIEW');
  });

  it('falls back to INFORMATIONAL (low-risk read-only) when codex call fails', async () => {
    // Regression for #280: a classifier outage used to fall back to IMPLEMENTATION,
    // which required builder-level access and could deny a viewer's DM or escalate
    // a read-only ask into the implementation workflow. INFORMATIONAL keeps the ask
    // answerable at viewer-level.
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: false,
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: 'error',
      lastMessage: '',
      parsedJson: undefined,
    });
    const result = await classifyWorkflowIntent({ userMessage: 'do something', hasPrUrl: false });
    expect(result.intent).toBe('INFORMATIONAL');
    expect(result.confidence).toBe(0);
  });

  it('falls back to INFORMATIONAL when JSON parsing fails', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'not json',
      parsedJson: undefined,
    });
    const result = await classifyWorkflowIntent({ userMessage: 'build a feature', hasPrUrl: false });
    expect(result.intent).toBe('INFORMATIONAL');
  });

  it('falls back to INFORMATIONAL for invalid intent value', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: { intent: 'INVALID_INTENT', confidence: 0.8, reasoning: 'bad' },
    });
    const result = await classifyWorkflowIntent({ userMessage: 'test', hasPrUrl: false });
    expect(result.intent).toBe('INFORMATIONAL');
  });

  it('falls back to INFORMATIONAL when codex throws', async () => {
    vi.mocked(runCodex).mockRejectedValueOnce(new Error('network error'));
    const result = await classifyWorkflowIntent({ userMessage: 'test', hasPrUrl: false });
    expect(result.intent).toBe('INFORMATIONAL');
    expect(result.confidence).toBe(0);
  });
});
