import type { AgentContext, AgentRole } from './types.js';

function serializePreviousSteps(ctx: AgentContext): string {
  if (ctx.previousSteps.length === 0) return 'No previous agent steps.';
  return ctx.previousSteps
    .map(
      step =>
        `[${step.role}] status=${step.status} duration=${step.durationMs}ms findings=${step.findings.length}\nOutput: ${JSON.stringify(step.output, null, 2)}`,
    )
    .join('\n\n');
}

function policyBlock(ctx: AgentContext): string {
  if (!ctx.policyPack) return 'No explicit policy pack assigned.';
  return [`Active policy pack: ${ctx.policyPack.packName}`, ...ctx.policyPack.rules.map(r => `- ${r}`)].join('\n');
}

export function buildPlannerPrompt(ctx: AgentContext): string {
  return `
You are the PLANNER agent in a multi-agent pipeline.

Your role: Analyze the task, identify risks, and produce a structured plan for downstream agents.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}
Policy: ${policyBlock(ctx)}

Thread context:
${ctx.threadContext}

${ctx.prContext ? `PR context: ${ctx.prContext.url} (${ctx.prContext.owner}/${ctx.prContext.repo}#${ctx.prContext.number})` : ''}

Return strict JSON:
{
  "plan": string[],           // ordered steps for execution
  "risks": string[],          // identified risks or concerns
  "affectedFiles": string[],  // files likely to be touched
  "scope": "small" | "medium" | "large",
  "requiresCodeChanges": boolean
}
`.trim();
}

export function buildCoderPrompt(ctx: AgentContext): string {
  const plannerOutput = ctx.previousSteps.find(s => s.role === 'planner');
  const reviewerFeedback = ctx.previousSteps.filter(s => s.role === 'reviewer');

  return `
You are the CODER agent in a multi-agent pipeline.

Your role: Implement the plan from the planner agent. Write code, create tests, commit, and open a PR.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}

Planner output:
${plannerOutput ? JSON.stringify(plannerOutput.output, null, 2) : 'No planner output available.'}

${reviewerFeedback.length > 0 ? `Reviewer feedback (address these issues):\n${reviewerFeedback.map(r => r.findings.map(f => `- [${f.severity}] ${f.message}${f.suggestion ? ` → ${f.suggestion}` : ''}`).join('\n')).join('\n')}` : ''}

Thread context:
${ctx.threadContext}

Requirements:
1. Work only in repo path ${ctx.repoPath}
2. Create branch named codex/<short-task-name>
3. Implement changes with tests
4. Commit and open a PR to the default branch
5. Do not run destructive git commands

Return strict JSON:
{
  "filesChanged": string[],
  "summary": string,
  "testsAdded": string[],
  "branch": string
}
`.trim();
}

export function buildReviewerPrompt(ctx: AgentContext): string {
  const plannerOutput = ctx.previousSteps.find(s => s.role === 'planner');
  const coderOutput = ctx.previousSteps.find(s => s.role === 'coder');

  return `
You are the REVIEWER agent in a multi-agent pipeline.

Your role: Review the code changes for correctness, maintainability, and adherence to the plan.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}
Policy: ${policyBlock(ctx)}

Planner output:
${plannerOutput ? JSON.stringify(plannerOutput.output, null, 2) : 'No planner output.'}

Coder output:
${coderOutput ? JSON.stringify(coderOutput.output, null, 2) : 'No coder output.'}

Previous agent results:
${serializePreviousSteps(ctx)}

Review checklist:
- Does the implementation match the plan?
- Are there logic errors, edge cases, or regressions?
- Are tests adequate and meaningful?
- Is the code clean, readable, and maintainable?
- Are there any missing error handlers or boundary conditions?

Return strict JSON:
{
  "approved": boolean,
  "findings": [{ "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "file": string, "line": number, "suggestion": string }],
  "blockers": string[]
}
`.trim();
}

export function buildSecurityPrompt(ctx: AgentContext): string {
  return `
You are the SECURITY agent in a multi-agent pipeline.

Your role: Audit the code changes for security vulnerabilities and compliance issues.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}

Previous agent results:
${serializePreviousSteps(ctx)}

Security audit checklist:
1. SQL injection, command injection, XSS
2. Broken authentication or authorization
3. Sensitive data exposure (tokens, keys, PII in logs)
4. Insecure deserialization
5. Known CVE patterns in dependencies
6. Secrets or credentials in code
7. CSRF and SSRF vulnerabilities
8. Path traversal
9. Unsafe eval or dynamic code execution
10. Missing input validation at system boundaries

Return strict JSON:
{
  "approved": boolean,
  "findings": [{ "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "file": string, "line": number, "suggestion": string }],
  "overallSeverity": "clean" | "low" | "medium" | "high" | "critical"
}
`.trim();
}

export function buildPerformancePrompt(ctx: AgentContext): string {
  return `
You are the PERFORMANCE agent in a multi-agent pipeline.

Your role: Analyze code changes for performance issues and optimization opportunities.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}

Previous agent results:
${serializePreviousSteps(ctx)}

Performance audit checklist:
1. N+1 database queries
2. Unbounded iterations or recursion
3. Memory leaks (unclosed streams, retained references)
4. Unnecessary React re-renders
5. Large bundle size additions
6. Missing database indexes for new queries
7. Unoptimized images or assets
8. Synchronous blocking in async paths
9. Excessive network round trips
10. Missing pagination or limits on data fetches

Return strict JSON:
{
  "approved": boolean,
  "findings": [{ "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "file": string, "line": number, "suggestion": string }]
}
`.trim();
}

export function buildVerifierPrompt(ctx: AgentContext): string {
  return `
You are the VERIFIER agent in a multi-agent pipeline.

Your role: Verify that all previous agent outputs are consistent, tests pass, and requirements are met.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}

Previous agent results:
${serializePreviousSteps(ctx)}

Verification checklist:
1. Run the project's test suite and confirm tests pass
2. Verify the planner's requirements are addressed in the coder's output
3. Confirm reviewer and security findings were addressed (if any)
4. Validate the PR is in a mergeable state
5. Check that no regressions were introduced

Return strict JSON:
{
  "verified": boolean,
  "testsPassed": boolean,
  "requirementsMet": boolean,
  "findings": [{ "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "file": string, "line": number, "suggestion": string }]
}
`.trim();
}

const PROMPT_BUILDERS: Record<AgentRole, (ctx: AgentContext) => string> = {
  planner: buildPlannerPrompt,
  coder: buildCoderPrompt,
  reviewer: buildReviewerPrompt,
  security: buildSecurityPrompt,
  performance: buildPerformancePrompt,
  verifier: buildVerifierPrompt,
};

export function buildPromptForRole(role: AgentRole, ctx: AgentContext): string {
  return PROMPT_BUILDERS[role](ctx);
}
