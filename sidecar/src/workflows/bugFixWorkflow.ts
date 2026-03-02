import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, CodexRunRequest, NormalizedTask, WorkflowResult } from '../types/contracts.js';
import { fetchThreadContext } from '../slack/threadContext.js';
import { classifyRepo } from '../router/repoClassifier.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { runCodex } from '../codex/runCodex.js';
import { githubAuthModeHint, resolveGithubTokenForCodex } from '../github/githubAuth.js';

export async function runBugFixWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
}): Promise<WorkflowResult> {
  const { task, config, slack } = params;

  if (!config.allowedChannelsForBugFix.includes(task.event.channelId)) {
    return {
      workflow: 'BUG_FIX',
      status: 'SKIPPED',
      message: 'Bug fix workflow is only allowed in configured channels.',
      notifyDesktop: false,
      slackPosted: false,
    };
  }

  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs);
  const texts = [task.event.text, ...threadMessages.map(message => message.text)];
  const classification = classifyRepo(texts, config.repoClassifierThreshold);

  if (classification.uncertain || !classification.selectedRepo) {
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

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: `Working on bug fix in ${classification.selectedRepo}...`,
  });

  const githubToken = await resolveGithubTokenForCodex();

  const prompt = `
You are running Watchtower bug-fix automation.

Thread summary:
${texts.join('\n---\n')}

GitHub auth mode:
${githubAuthModeHint(Boolean(githubToken))}

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
  };

  const result = await runCodex(request);

  if (!result.ok || !result.parsedJson) {
    const errorText = result.timedOut
      ? 'Bug-fix workflow timed out.'
      : `Bug-fix workflow failed (exit=${result.exitCode ?? 'unknown'}).`;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `${errorText} Check desktop notifications for details.`,
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

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: `Bug fix completed. ${summary}\n${prUrl}`,
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
