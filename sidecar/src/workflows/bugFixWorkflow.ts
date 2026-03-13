import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  NormalizedTask,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import { fetchThreadContext } from '../slack/threadContext.js';
import { classifyRepo } from '../router/repoClassifier.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { runCodex } from '../codex/runCodex.js';
import { HIGH_REASONING_CODEX_PROFILE } from '../codex/modelProfiles.js';
import { githubAuthModeHint, resolveGithubTokenForCodex } from '../github/githubAuth.js';
import type { JobStore } from '../state/jobStore.js';
import { runAgentPipeline } from '../agents/pipeline.js';
import type { PipelineConfig } from '../agents/types.js';

export async function runBugFixWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: Pick<JobStore, 'getChannelPolicyPack'>;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, logStep } = params;

  if (!config.allowedChannelsForBugFix.includes(task.event.channelId)) {
    logStep?.({
      stage: 'bug_fix.guard.channel_rejected',
      message: 'Bug-fix workflow blocked because channel is not allowlisted.',
      level: 'WARN',
      data: {
        channelId: task.event.channelId,
      },
    });

    return {
      workflow: 'BUG_FIX',
      status: 'SKIPPED',
      message: 'Bug fix workflow is only allowed in configured channels.',
      notifyDesktop: false,
      slackPosted: false,
    };
  }

  logStep?.({
    stage: 'bug_fix.context.fetch.start',
    message: 'Fetching full thread context for bug-fix classification.',
  });

  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs);
  const texts = [task.event.text, ...threadMessages.map(message => message.text)];
  const classification = classifyRepo(texts, config.repoClassifierThreshold);

  logStep?.({
    stage: 'bug_fix.context.fetch.done',
    message: 'Thread context and repository classification computed.',
    data: {
      messages: threadMessages.length,
      selectedRepo: classification.selectedRepo,
      confidence: classification.confidence,
      threshold: config.repoClassifierThreshold,
      uncertain: classification.uncertain,
      scoreWeb: classification.scoreWeb,
      scoreApi: classification.scoreApi,
    },
  });

  if (classification.uncertain || !classification.selectedRepo) {
    logStep?.({
      stage: 'bug_fix.classifier.uncertain',
      message: 'Classifier confidence below threshold; skipping autonomous execution.',
      level: 'WARN',
      data: {
        selectedRepo: classification.selectedRepo,
        confidence: classification.confidence,
        threshold: config.repoClassifierThreshold,
      },
    });

    notifyDesktop(
      'Watchtower uncertain repo classification',
      `Could not confidently classify bug thread ${task.event.threadTs} (confidence=${classification.confidence.toFixed(2)}).`
    );

    return {
      workflow: 'BUG_FIX',
      status: 'SKIPPED',
      message: 'Repo classification uncertain; desktop notification only.',
      notifyDesktop: true,
      slackPosted: false,
      result: {
        classification,
      },
    };
  }

  const repoPath = classification.selectedRepo === 'newton-web' ? config.repoPaths.newtonWeb : config.repoPaths.newtonApi;

  logStep?.({
    stage: 'bug_fix.repo.selected',
    message: 'Selected repository for bug-fix execution.',
    data: {
      repo: classification.selectedRepo,
      repoPath,
    },
  });

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: `Bug-fix run started in ${classification.selectedRepo}.`,
  });

  logStep?.({
    stage: 'bug_fix.slack.ack_posted',
    message: 'Posted bug-fix start acknowledgement to Slack thread.',
  });

  const githubToken = await resolveGithubTokenForCodex();

  logStep?.({
    stage: 'bug_fix.github.auth_resolved',
    message: 'Resolved GitHub auth mode for bug-fix Codex execution.',
    data: { tokenInjected: Boolean(githubToken) },
  });

  const policyPack = store?.getChannelPolicyPack(task.event.channelId);
  const policyBlock = policyPack
    ? [
        `Active policy pack: ${policyPack.packName}`,
        ...policyPack.rules.map(rule => `- ${rule}`),
      ].join('\n')
    : 'No explicit policy pack assigned for this channel.';

  // --- Multi-agent pipeline path ---
  if (config.multiAgentEnabled) {
    logStep?.({
      stage: 'bug_fix.pipeline.start',
      message: 'Running bug-fix through multi-agent pipeline.',
    });

    const pipelineConfig: PipelineConfig = {
      agents: ['planner', 'coder', 'reviewer', 'security', 'verifier'],
      maxRetryLoops: 2,
      perAgentTimeoutMs: config.workflowTimeouts.bugFixMs / 5,
      totalTimeoutMs: config.workflowTimeouts.bugFixMs,
      abortOnCriticalFinding: true,
      slackProgressUpdates: true,
    };

    const threadContext = texts.join('\n---\n');
    const pipelineResult = await runAgentPipeline({
      ctx: {
        workflowIntent: 'BUG_FIX',
        task,
        config,
        repoPath,
        githubToken,
        threadContext,
        previousSteps: [],
        pipelineConfig,
        policyPack: policyPack ? { packName: policyPack.packName, rules: policyPack.rules } : undefined,
      },
      slack,
      logStep: logStep ?? (() => {}),
    });

    const coderStep = pipelineResult.steps.find(s => s.role === 'coder');
    const summary = coderStep?.output?.summary
      ? String(coderStep.output.summary)
      : `Bug-fix pipeline ${pipelineResult.finalStatus}.`;
    const prUrl = coderStep?.output?.prUrl ? String(coderStep.output.prUrl) : '';
    const qualityReport = pipelineResult.aggregatedFindings
      .map(f => `- [${f.severity}] ${f.message}`)
      .join('\n');

    const slackText = qualityReport
      ? `Bug fix wrapped. ${summary}\n${prUrl}\n\nQuality report:\n${qualityReport}`
      : `Bug fix wrapped. ${summary}\n${prUrl}`;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: slackText,
    });

    return {
      workflow: 'BUG_FIX',
      status: pipelineResult.finalStatus === 'passed' ? 'SUCCESS' : 'FAILED',
      message: summary,
      notifyDesktop: false,
      slackPosted: true,
      result: {
        pipelineStatus: pipelineResult.finalStatus,
        prUrl,
        totalFindings: pipelineResult.aggregatedFindings.length,
      },
    };
  }

  // --- Single-agent path (legacy) ---
  const prompt = `
${buildMentionSystemPrompt({ task, workflow: 'BUG_FIX' })}

You are running Watchtower bug-fix automation.

Thread summary:
${texts.join('\n---\n')}

GitHub auth mode:
${githubAuthModeHint(Boolean(githubToken))}

Policy pack:
${policyBlock}

Requirements:
1. Work only in repo path ${repoPath}
2. Create branch named codex/<short-task-name>
3. Implement the fix with tests
4. Commit and open a PR to default branch
5. Return strict JSON with fields: status, summary, prUrl, branch, tests
6. Do not run destructive git commands
`.trim();

  const request: CodexRunRequest = {
    cwd: repoPath,
    prompt,
    timeoutMs: config.workflowTimeouts.bugFixMs,
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/bug-fix-result.schema.json'),
    githubToken,
    ...HIGH_REASONING_CODEX_PROFILE,
    onLog: logStep,
  };

  logStep?.({
    stage: 'bug_fix.codex.start',
    message: 'Starting Codex bug-fix execution with high-reasoning profile.',
    data: {
      repoPath,
      timeoutMs: config.workflowTimeouts.bugFixMs,
    },
  });

  const result = await runCodex(request);

  logStep?.({
    stage: 'bug_fix.codex.finish',
    message: 'Codex bug-fix execution finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: {
      ok: result.ok,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      parsedJson: Boolean(result.parsedJson),
    },
  });

  if (!result.ok || !result.parsedJson) {
    const errorText = result.timedOut
      ? 'Bug-fix workflow timed out.'
      : `Bug-fix workflow failed (exit=${result.exitCode ?? 'unknown'}).`;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `${errorText} Check desktop notifications for details.`,
    });
    logStep?.({
      stage: 'bug_fix.slack.failure_posted',
      message: 'Posted bug-fix failure status to Slack thread.',
      level: 'ERROR',
      data: {
        errorText,
      },
    });

    notifyDesktop('Watchtower bug-fix failed', `${errorText} thread=${task.event.threadTs}`);

    return {
      workflow: 'BUG_FIX',
      status: 'FAILED',
      message: errorText,
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  const summary = String(result.parsedJson.summary ?? 'Bug fix completed.');
  const prUrl = String(result.parsedJson.prUrl ?? '');

  logStep?.({
    stage: 'bug_fix.result.parsed',
    message: 'Parsed bug-fix result payload.',
    data: {
      summary,
      prUrl,
      branch: String(result.parsedJson.branch ?? ''),
    },
  });

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: `Bug fix wrapped. ${summary}\n${prUrl}`,
  });

  logStep?.({
    stage: 'bug_fix.slack.success_posted',
    message: 'Posted bug-fix completion status to Slack thread.',
    data: {
      prUrl,
    },
  });

  return {
    workflow: 'BUG_FIX',
    status: 'SUCCESS',
    message: summary,
    notifyDesktop: false,
    slackPosted: true,
    result: result.parsedJson,
  };
}
