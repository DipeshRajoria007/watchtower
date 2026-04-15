import type { AgentCallRow, PipelineRunData } from '../types';
import { formatCostUsd, formatTokens } from '../lib/formatters';
import { SlackMarkdown } from './primitives';

type AgentStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

type AgentStepData = PipelineRunData['steps'][number];

type AgentPipelineViewProps = {
  pipelineRun: PipelineRunData | null;
  calls?: AgentCallRow[];
};

interface RoleUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  hasData: boolean;
}

function aggregateUsageByRole(calls: AgentCallRow[] | undefined, pipelineRunId: string): Map<string, RoleUsage> {
  const map = new Map<string, RoleUsage>();
  if (!calls) return map;
  for (const call of calls) {
    if (call.pipelineRunId !== pipelineRunId) continue;
    if (!call.role) continue;
    const existing = map.get(call.role) ?? {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      hasData: false,
    };
    existing.costUsd += call.costUsd ?? 0;
    existing.inputTokens += call.inputTokens ?? 0;
    existing.outputTokens += call.outputTokens ?? 0;
    existing.cacheReadTokens += call.cacheReadTokens ?? 0;
    existing.hasData = true;
    map.set(call.role, existing);
  }
  return map;
}

function totalCostFromCalls(calls: AgentCallRow[] | undefined, pipelineRunId: string): number {
  if (!calls) return 0;
  return calls.reduce((acc, c) => (c.pipelineRunId === pipelineRunId ? acc + (c.costUsd ?? 0) : acc), 0);
}

function statusIndicator(status: AgentStepStatus): string {
  switch (status) {
    case 'passed':
      return '\u2713';
    case 'failed':
      return '\u2717';
    case 'running':
      return '\u25CB';
    case 'skipped':
      return '\u2014';
    case 'pending':
      return '\u00B7';
  }
}

function statusToneClass(status: AgentStepStatus): string {
  switch (status) {
    case 'passed':
      return 'pipeline-step-passed';
    case 'failed':
      return 'pipeline-step-failed';
    case 'running':
      return 'pipeline-step-running';
    default:
      return 'pipeline-step-neutral';
  }
}

function severityToneClass(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'finding-critical';
    case 'high':
      return 'finding-high';
    case 'medium':
      return 'finding-medium';
    case 'low':
      return 'finding-low';
    default:
      return 'finding-info';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function AgentPipelineView({ pipelineRun, calls }: AgentPipelineViewProps) {
  if (!pipelineRun) return null;

  const usageByRole = aggregateUsageByRole(calls, pipelineRun.id);
  const totalCostUsd = totalCostFromCalls(calls, pipelineRun.id);

  return (
    <div className="pipeline-view">
      <div className="pipeline-header">
        <h4>Agent Pipeline</h4>
        <span className={`pipeline-status pipeline-status-${pipelineRun.status}`}>{pipelineRun.status}</span>
        {pipelineRun.totalDurationMs != null && (
          <span className="pipeline-duration">{formatDuration(pipelineRun.totalDurationMs)}</span>
        )}
        {totalCostUsd > 0 && <span className="pipeline-cost">{formatCostUsd(totalCostUsd)}</span>}
        {pipelineRun.retryLoops > 0 && <span className="pipeline-retries">{pipelineRun.retryLoops} retry loop(s)</span>}
      </div>

      <div className="pipeline-steps">
        {pipelineRun.steps.map((step, i) => (
          <PipelineStep
            key={`${step.role}-${i}`}
            step={step}
            index={i}
            total={pipelineRun.steps.length}
            usage={usageByRole.get(step.role)}
          />
        ))}
      </div>
    </div>
  );
}

function PipelineStep({
  step,
  index,
  total,
  usage,
}: {
  step: AgentStepData;
  index: number;
  total: number;
  usage?: RoleUsage;
}) {
  return (
    <div className={`pipeline-step ${statusToneClass(step.status)}`}>
      <div className="pipeline-step-header">
        <span className="pipeline-step-indicator">{statusIndicator(step.status)}</span>
        <span className="pipeline-step-label">
          {index + 1}/{total} {step.role}
        </span>
        <span className="pipeline-step-duration">{formatDuration(step.durationMs)}</span>
        {usage?.hasData && (
          <span className="pipeline-step-cost">
            {formatCostUsd(usage.costUsd)} · {formatTokens(usage.inputTokens)}↓ {formatTokens(usage.outputTokens)}↑
            {usage.cacheReadTokens > 0 ? ` · cache ${formatTokens(usage.cacheReadTokens)}` : ''}
          </span>
        )}
        {step.findings.length > 0 && (
          <span className="pipeline-step-findings-count">{step.findings.length} finding(s)</span>
        )}
      </div>

      {step.findings.length > 0 && (
        <div className="pipeline-findings">
          {step.findings.map((finding, fi) => (
            <div key={fi} className={`pipeline-finding ${severityToneClass(finding.severity)}`}>
              <span className="finding-severity">{finding.severity}</span>
              <span className="finding-category">{finding.category}</span>
              <span className="finding-message">
                <SlackMarkdown text={finding.message} />
              </span>
              {finding.file && (
                <span className="finding-location">
                  {finding.file}
                  {finding.line ? `:${finding.line}` : ''}
                </span>
              )}
              {finding.suggestion && (
                <span className="finding-suggestion">
                  <SlackMarkdown text={finding.suggestion} />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
