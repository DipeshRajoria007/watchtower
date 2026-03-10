import type { WorkflowIntent, WorkflowStepLog } from '../types/contracts.js';

export type FailureDiagnosis = {
  errorKind: string;
  summary: string;
  actions: string[];
};

export function diagnoseFailure(input: {
  workflow: WorkflowIntent;
  message: string;
  logs: WorkflowStepLog[];
}): FailureDiagnosis | undefined {
  const haystack = `${input.message}\n${input.logs
    .map(entry => `${entry.stage} ${entry.message} ${JSON.stringify(entry.data ?? {})}`)
    .join('\n')}`.toLowerCase();
  const codexParseFailureCount = input.logs.filter(
    entry =>
      entry.stage === 'codex.output.parse_failed' ||
      entry.stage === 'codex.output.schema_failed' ||
      entry.stage === 'codex.output.schema_invalid'
  ).length;

  if (haystack.includes('spawn codex enoent') || haystack.includes('codex executable not found')) {
    return {
      errorKind: 'CODEX_BIN_NOT_FOUND',
      summary: 'Codex CLI could not be launched from the app runtime.',
      actions: [
        'Install Codex CLI and ensure it exists in a stable absolute path.',
        'Set CODEX_BIN in app launch environment if needed.',
        'Relaunch Watchtower from /Applications (not a mounted DMG).',
      ],
    };
  }

  if (haystack.includes('node_module_version') || haystack.includes('better-sqlite3')) {
    return {
      errorKind: 'NATIVE_MODULE_ABI_MISMATCH',
      summary: 'A native module ABI mismatch was detected for better-sqlite3.',
      actions: [
        'Rebuild sidecar dependencies against the active Node version.',
        'Prefer one Node runtime path for packaged execution.',
        'Reinstall the latest Watchtower build after rebuild.',
      ],
    };
  }

  if (
    codexParseFailureCount >= 2 ||
    (codexParseFailureCount >= 1 &&
      (haystack.includes('schema mismatch') ||
        haystack.includes('output schema') ||
        haystack.includes('not valid json')))
  ) {
    return {
      errorKind: 'CODEX_OUTPUT_SCHEMA',
      summary: 'Codex output repeatedly failed JSON/schema parsing.',
      actions: [
        'Tighten prompt output instructions to emit strict JSON only.',
        'Log and inspect the raw final message preview for malformed wrappers.',
        'Use fallback salvage parsing and retry only when parsed JSON is unavailable.',
      ],
    };
  }

  if (haystack.includes('enotfound slack.com') || haystack.includes('could not resolve github.com')) {
    return {
      errorKind: 'NETWORK_DNS',
      summary: 'Network/DNS resolution failed while contacting Slack or GitHub.',
      actions: [
        'Verify internet and DNS stability on the host.',
        'Retry the task once connectivity is restored.',
        'Consider adding a secondary DNS resolver for reliability.',
      ],
    };
  }

  const githubAuthOrApiError =
    /api\.github\.com[^\n]*(error|failed|forbidden|unauthorized|timed out|unreachable|refused|denied|401|403|404)/.test(
      haystack
    ) ||
    /github(?:\s+auth|\s+authentication)?[^\n]*(failed|failure|error|invalid|denied|forbidden|unauthorized|missing|expired)/.test(
      haystack
    ) ||
    /token[^\n]*(invalid|expired|missing|denied|forbidden|unauthorized|revoked|scope)/.test(haystack) ||
    haystack.includes('bad credentials') ||
    haystack.includes('resource not accessible by integration') ||
    haystack.includes('insufficient scope');

  if (githubAuthOrApiError) {
    return {
      errorKind: 'GITHUB_AUTH_OR_API',
      summary: 'GitHub API/auth failed during workflow execution.',
      actions: [
        'Check GitHub token scope/validity (repo + pull request access).',
        'Verify API connectivity from the host.',
        'Retry after refreshing credentials.',
      ],
    };
  }

  if (haystack.includes('timeout') || haystack.includes('timed out')) {
    return {
      errorKind: 'WORKFLOW_TIMEOUT',
      summary: 'The workflow hit its execution timeout.',
      actions: [
        'Increase timeout in Settings for this workflow.',
        'Narrow the task scope (smaller PR/context).',
        'Retry after reducing external dependency latency.',
      ],
    };
  }

  if (haystack.includes('missing_scope')) {
    return {
      errorKind: 'SLACK_SCOPE',
      summary: 'Slack scope is missing for one of the requested actions.',
      actions: [
        'Add missing scope to Slack app (for example reactions:write).',
        'Reinstall/re-authorize the app in the workspace.',
      ],
    };
  }

  if (haystack.includes('429') || haystack.includes('rate limit')) {
    return {
      errorKind: 'RATE_LIMIT',
      summary: 'Rate limiting was encountered while executing API operations.',
      actions: [
        'Retry with backoff and lower parallelism.',
        'Reduce redundant retries for non-critical follow-up actions.',
      ],
    };
  }

  return undefined;
}
