type AgentStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

type AgentFinding = {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
};

type AgentStepData = {
  role: string;
  status: AgentStepStatus;
  durationMs: number;
  findings: AgentFinding[];
};

type PipelineRunData = {
  id: string;
  jobId: string;
  status: string;
  steps: AgentStepData[];
  retryLoops: number;
  totalDurationMs: number | null;
};

type AgentPipelineViewProps = {
  pipelineRun: PipelineRunData | null;
};

function statusIndicator(status: AgentStepStatus): string {
  switch (status) {
    case 'passed': return '\u2713';
    case 'failed': return '\u2717';
    case 'running': return '\u25CB';
    case 'skipped': return '\u2014';
    case 'pending': return '\u00B7';
  }
}

function statusToneClass(status: AgentStepStatus): string {
  switch (status) {
    case 'passed': return 'pipeline-step-passed';
    case 'failed': return 'pipeline-step-failed';
    case 'running': return 'pipeline-step-running';
    default: return 'pipeline-step-neutral';
  }
}

function severityToneClass(severity: string): string {
  switch (severity) {
    case 'critical': return 'finding-critical';
    case 'high': return 'finding-high';
    case 'medium': return 'finding-medium';
    case 'low': return 'finding-low';
    default: return 'finding-info';
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

export function AgentPipelineView({ pipelineRun }: AgentPipelineViewProps) {
  if (!pipelineRun) return null;

  return (
    <div className="pipeline-view">
      <div className="pipeline-header">
        <h4>Agent Pipeline</h4>
        <span className={`pipeline-status pipeline-status-${pipelineRun.status}`}>
          {pipelineRun.status}
        </span>
        {pipelineRun.totalDurationMs != null && (
          <span className="pipeline-duration">{formatDuration(pipelineRun.totalDurationMs)}</span>
        )}
        {pipelineRun.retryLoops > 0 && (
          <span className="pipeline-retries">{pipelineRun.retryLoops} retry loop(s)</span>
        )}
      </div>

      <div className="pipeline-steps">
        {pipelineRun.steps.map((step, i) => (
          <PipelineStep key={`${step.role}-${i}`} step={step} index={i} total={pipelineRun.steps.length} />
        ))}
      </div>
    </div>
  );
}

function PipelineStep({ step, index, total }: { step: AgentStepData; index: number; total: number }) {
  return (
    <div className={`pipeline-step ${statusToneClass(step.status)}`}>
      <div className="pipeline-step-header">
        <span className="pipeline-step-indicator">{statusIndicator(step.status)}</span>
        <span className="pipeline-step-label">
          {index + 1}/{total} {step.role}
        </span>
        <span className="pipeline-step-duration">{formatDuration(step.durationMs)}</span>
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
              <span className="finding-message">{finding.message}</span>
              {finding.file && (
                <span className="finding-location">
                  {finding.file}{finding.line ? `:${finding.line}` : ''}
                </span>
              )}
              {finding.suggestion && (
                <span className="finding-suggestion">{finding.suggestion}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
