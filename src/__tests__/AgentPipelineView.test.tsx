import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentPipelineView } from '../components/AgentPipelineView';

describe('AgentPipelineView', () => {
  it('renders nothing when pipelineRun is null', () => {
    const { container } = render(<AgentPipelineView pipelineRun={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders pipeline status and steps', () => {
    const pipelineRun = {
      id: 'run-1',
      jobId: 'job-1',
      status: 'passed',
      steps: [
        {
          role: 'planner',
          status: 'passed' as const,
          durationMs: 1200,
          findings: [],
        },
        {
          role: 'reviewer',
          status: 'passed' as const,
          durationMs: 3400,
          findings: [
            {
              severity: 'medium' as const,
              category: 'style',
              message: 'Consider renaming variable',
            },
          ],
        },
      ],
      retryLoops: 0,
      totalDurationMs: 4600,
    };

    render(<AgentPipelineView pipelineRun={pipelineRun} />);

    expect(screen.getByText('Agent Pipeline')).toBeTruthy();
    expect(screen.getByText('passed')).toBeTruthy();
    expect(screen.getByText(/planner/)).toBeTruthy();
    expect(screen.getByText(/reviewer/)).toBeTruthy();
    expect(screen.getByText('Consider renaming variable')).toBeTruthy();
  });

  it('shows retry loop count when retries occurred', () => {
    const pipelineRun = {
      id: 'run-2',
      jobId: 'job-2',
      status: 'failed',
      steps: [
        {
          role: 'coder',
          status: 'passed' as const,
          durationMs: 5000,
          findings: [],
        },
        {
          role: 'reviewer',
          status: 'failed' as const,
          durationMs: 2000,
          findings: [
            {
              severity: 'high' as const,
              category: 'logic',
              message: 'Missing null check',
            },
          ],
        },
      ],
      retryLoops: 2,
      totalDurationMs: 15000,
    };

    render(<AgentPipelineView pipelineRun={pipelineRun} />);
    expect(screen.getByText('2 retry loop(s)')).toBeTruthy();
  });
});
