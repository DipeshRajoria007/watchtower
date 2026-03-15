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
import { downloadSlackImages } from '../slack/imageDownloader.js';
import { classifyRepo } from '../router/repoClassifier.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { githubAuthModeHint, resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { createBranch, captureGitDiff, pushBranch } from '../github/diffCapture.js';
import { getBackend } from '../backends/registry.js';
import type { JobStore } from '../state/jobStore.js';
import { runAgentPipeline } from '../agents/pipeline.js';
import type { PipelineStore } from '../agents/pipeline.js';
import type { PipelineConfig } from '../agents/types.js';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 30);
}

export async function runPmTaskWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: Pick<JobStore, 'getChannelPolicyPack' | 'saveDiff'> & Partial<PipelineStore>;
  jobId?: string;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, jobId, logStep } = params;

  logStep?.({
    stage: 'pm_task.context.fetch.start',
    message: 'Fetching full thread context for PM task classification.',
  });

  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs);
  const texts = [task.event.text, ...threadMessages.map(m => m.text)];
  const classification = classifyRepo(texts, config.repoClassifierThreshold);

  logStep?.({
    stage: 'pm_task.context.fetch.done',
    message: 'Thread context and repo classification computed for PM task.',
    data: {
      messages: threadMessages.length,
      selectedRepo: classification.selectedRepo,
      confidence: classification.confidence,
      uncertain: classification.uncertain,
    },
  });

  if (classification.uncertain || !classification.selectedRepo) {
    logStep?.({
      stage: 'pm_task.classifier.uncertain',
      message: 'Classifier confidence below threshold; skipping PM task.',
      level: 'WARN',
    });

    notifyDesktop(
      'Watchtower PM task uncertain repo',
      `Could not confidently classify PM task thread ${task.event.threadTs}.`
    );

    return {
      workflow: 'PM_TASK',
      status: 'SKIPPED',
      message: 'Repo classification uncertain; desktop notification only.',
      notifyDesktop: true,
      slackPosted: false,
      result: { classification },
    };
  }

  const repoPath = classification.selectedRepo === 'newton-web'
    ? config.repoPaths.newtonWeb
    : config.repoPaths.newtonApi;

  // Download images from thread if present
  const allFiles = threadMessages.flatMap(m => m.files ?? []);
  let imagePaths: string[] = [];
  if (allFiles.length > 0) {
    logStep?.({
      stage: 'pm_task.images.download.start',
      message: `Downloading ${allFiles.length} image(s) from thread.`,
    });
    try {
      imagePaths = await downloadSlackImages({
        files: allFiles,
        botToken: config.slackBotToken,
      });
      logStep?.({
        stage: 'pm_task.images.download.done',
        message: `Downloaded ${imagePaths.length} image(s).`,
        data: { count: imagePaths.length },
      });
    } catch (error) {
      logStep?.({
        stage: 'pm_task.images.download.error',
        message: `Image download failed: ${String(error)}`,
        level: 'WARN',
      });
    }
  }

  // Create a branch for the PM's changes
  const slug = slugify(task.event.text?.slice(0, 40) || 'pm-task');
  const branchName = `miniog/pm-${slug}-${Date.now()}`;

  logStep?.({
    stage: 'pm_task.branch.create',
    message: `Creating branch ${branchName} in ${classification.selectedRepo}.`,
  });

  try {
    await createBranch(repoPath, branchName);
  } catch (error) {
    logStep?.({
      stage: 'pm_task.branch.create.error',
      message: `Failed to create branch: ${String(error)}`,
      level: 'ERROR',
    });

    return {
      workflow: 'PM_TASK',
      status: 'FAILED',
      message: `Failed to create branch: ${String(error)}`,
      notifyDesktop: true,
      slackPosted: false,
    };
  }

  // Acknowledge in Slack
  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: `PM task started in ${classification.selectedRepo} on branch \`${branchName}\`.`,
  });

  logStep?.({
    stage: 'pm_task.slack.ack_posted',
    message: 'Posted PM task start acknowledgement to Slack.',
  });

  const githubToken = await resolveGithubTokenForCodex();

  logStep?.({
    stage: 'pm_task.github.auth_resolved',
    message: 'Resolved GitHub auth for PM task.',
    data: { tokenInjected: Boolean(githubToken) },
  });

  const policyPack = store?.getChannelPolicyPack?.(task.event.channelId);
  const policyBlock = policyPack
    ? [`Active policy pack: ${policyPack.packName}`, ...policyPack.rules.map(rule => `- ${rule}`)].join('\n')
    : 'No explicit policy pack assigned for this channel.';

  const backend = getBackend(getActiveBackendId());
  const imageContext = imagePaths.length > 0 && !backend.supportsImages()
    ? `\n\n[${imagePaths.length} image(s) attached in thread — this backend does not support image input]`
    : '';

  // --- Multi-agent pipeline path ---
  if (config.multiAgentEnabled) {
    logStep?.({
      stage: 'pm_task.pipeline.start',
      message: 'Running PM task through multi-agent pipeline.',
    });

    const pipelineConfig: PipelineConfig = {
      agents: ['planner', 'coder', 'reviewer', 'security', 'verifier'],
      maxRetryLoops: 2,
      perAgentTimeoutMs: config.workflowTimeouts.pmTaskMs / 5,
      totalTimeoutMs: config.workflowTimeouts.pmTaskMs,
      abortOnCriticalFinding: true,
      slackProgressUpdates: true,
    };

    const threadContext = texts.join('\n---\n') + imageContext;
    const pipelineResult = await runAgentPipeline({
      ctx: {
        workflowIntent: 'PM_TASK',
        task,
        config,
        repoPath,
        githubToken,
        threadContext,
        previousSteps: [],
        pipelineConfig,
        policyPack: policyPack ? { packName: policyPack.packName, rules: policyPack.rules } : undefined,
        imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
      },
      slack,
      logStep: logStep ?? (() => {}),
      store: store?.createPipelineRun && store?.updatePipelineRun ? store as PipelineStore : undefined,
      jobId,
    });

    // Capture diff and store
    let diffCapture;
    try {
      diffCapture = await captureGitDiff(repoPath);
      if (store?.saveDiff && jobId) {
        store.saveDiff({
          jobId,
          branchName: diffCapture.branchName,
          repoPath,
          diffText: diffCapture.diffText,
          files: diffCapture.files,
          insertions: diffCapture.totalInsertions,
          deletions: diffCapture.totalDeletions,
        });
      }
    } catch (error) {
      logStep?.({
        stage: 'pm_task.diff.capture.error',
        message: `Failed to capture diff: ${String(error)}`,
        level: 'WARN',
      });
    }

    // Push branch
    try {
      await pushBranch(repoPath, branchName);
      logStep?.({ stage: 'pm_task.branch.pushed', message: `Pushed branch ${branchName} to remote.` });
    } catch (error) {
      logStep?.({
        stage: 'pm_task.branch.push.error',
        message: `Failed to push branch: ${String(error)}`,
        level: 'WARN',
      });
    }

    const coderStep = pipelineResult.steps.find(s => s.role === 'coder');
    const summary = coderStep?.output?.summary
      ? String(coderStep.output.summary)
      : `PM task pipeline ${pipelineResult.finalStatus}.`;
    const prUrl = coderStep?.output?.prUrl ? String(coderStep.output.prUrl) : '';
    const filesChanged = diffCapture?.files.length ?? 0;

    const slackText = prUrl
      ? `PM task complete. ${summary}\n${prUrl}`
      : `PM task complete. ${summary}\nBranch: \`${branchName}\` (${filesChanged} files changed). Review changes in Watchtower.`;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: slackText,
    });

    return {
      workflow: 'PM_TASK',
      status: pipelineResult.finalStatus === 'passed' ? 'SUCCESS' : 'FAILED',
      message: summary,
      notifyDesktop: false,
      slackPosted: true,
      result: {
        pipelineStatus: pipelineResult.finalStatus,
        branchName,
        filesChanged: diffCapture?.files.map(f => f.path) ?? [],
        prUrl,
      },
    };
  }

  // --- Single-agent path ---
  const prompt = `
${buildMentionSystemPrompt({ task, workflow: 'PM_TASK' })}

You are running Watchtower PM task automation.
A product manager has requested a code change. Implement their request carefully.

Thread context:
${texts.join('\n---\n')}${imageContext}

GitHub auth mode:
${githubAuthModeHint(Boolean(githubToken))}

Policy pack:
${policyBlock}

Requirements:
1. Work only in repo path ${repoPath}
2. You are already on branch ${branchName} — commit your changes here
3. Implement the requested change with tests where appropriate
4. Commit your changes (do NOT create a PR — the PM will review and create one)
5. Return strict JSON with fields: status, summary, branch, filesChanged
6. Do not run destructive git commands
`.trim();

  const request: CodexRunRequest = {
    cwd: repoPath,
    prompt,
    timeoutMs: config.workflowTimeouts.pmTaskMs,
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/pm-task-result.schema.json'),
    githubToken,
    imagePaths: imagePaths.length > 0 && backend.supportsImages() ? imagePaths : undefined,
    ...highReasoningProfile(getActiveBackendId()),
    onLog: logStep,
  };

  logStep?.({
    stage: 'pm_task.agent.start',
    message: 'Starting agent execution for PM task with high-reasoning profile.',
    data: { repoPath, timeoutMs: config.workflowTimeouts.pmTaskMs, branchName },
  });

  const result = await runCodex(request);

  logStep?.({
    stage: 'pm_task.agent.finish',
    message: 'Agent PM task execution finished.',
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
      ? 'PM task workflow timed out.'
      : `PM task workflow failed (exit=${result.exitCode ?? 'unknown'}).`;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `${errorText} Check desktop notifications for details.`,
    });

    notifyDesktop('Watchtower PM task failed', `${errorText} thread=${task.event.threadTs}`);

    return {
      workflow: 'PM_TASK',
      status: 'FAILED',
      message: errorText,
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  // Capture diff
  let diffCapture;
  try {
    diffCapture = await captureGitDiff(repoPath);
    if (store?.saveDiff && jobId) {
      store.saveDiff({
        jobId,
        branchName: diffCapture.branchName,
        repoPath,
        diffText: diffCapture.diffText,
        files: diffCapture.files,
        insertions: diffCapture.totalInsertions,
        deletions: diffCapture.totalDeletions,
      });
    }
  } catch (error) {
    logStep?.({
      stage: 'pm_task.diff.capture.error',
      message: `Failed to capture diff: ${String(error)}`,
      level: 'WARN',
    });
  }

  // Push branch to remote
  try {
    await pushBranch(repoPath, branchName);
    logStep?.({ stage: 'pm_task.branch.pushed', message: `Pushed branch ${branchName} to remote.` });
  } catch (error) {
    logStep?.({
      stage: 'pm_task.branch.push.error',
      message: `Failed to push branch: ${String(error)}`,
      level: 'WARN',
    });
  }

  const summary = String(result.parsedJson.summary ?? 'PM task completed.');
  const filesChanged = diffCapture?.files.map(f => f.path) ?? [];

  logStep?.({
    stage: 'pm_task.result.parsed',
    message: 'Parsed PM task result.',
    data: { summary, branchName, filesChanged: filesChanged.length },
  });

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: `PM task complete. ${summary}\nBranch: \`${branchName}\` (${filesChanged.length} files changed). Review changes in Watchtower.`,
  });

  return {
    workflow: 'PM_TASK',
    status: 'SUCCESS',
    message: summary,
    notifyDesktop: false,
    slackPosted: true,
    result: {
      branchName,
      filesChanged,
      diffSummary: diffCapture
        ? `+${diffCapture.totalInsertions} -${diffCapture.totalDeletions}`
        : undefined,
    },
  };
}
