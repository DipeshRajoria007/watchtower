import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { parseDevAssistCommand } from '../router/devAssistParser.js';
import type { JobStore } from '../state/jobStore.js';

const HELP_TEXT = [
  'Watchtower Dev Assistant commands:',
  '- `wt help` -> show command help',
  '- `wt status` -> show current runtime health snapshot',
  '- `wt runs [n]` -> show latest runs (default 5)',
  '- `wt failures [n]` -> show latest failed runs (default 5)',
  '',
  'More commands are being added in the next updates.',
].join('\n');

export async function runDevAssistWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store: JobStore;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, logStep } = params;

  const command = parseDevAssistCommand(task.event.text);

  if (!command) {
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: 'I could not parse that `wt` command. Try `wt help`.',
    });

    logStep?.({
      stage: 'dev_assist.command.unparsed',
      message: 'Dev-assist command was not parseable.',
      level: 'WARN',
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SKIPPED',
      message: 'Unrecognized dev-assist command.',
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (command.type === 'HELP') {
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: HELP_TEXT,
    });

    logStep?.({
      stage: 'dev_assist.help.posted',
      message: 'Posted dev-assist help in Slack thread.',
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Posted dev-assist help.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'HELP',
      },
    };
  }

  if (command.type === 'STATUS') {
    const snapshot = store.getDevStatusSnapshot();
    const text = [
      'Watchtower status:',
      `- Active jobs: ${snapshot.activeJobs}/${config.maxConcurrentJobs}`,
      `- Runs (24h): ${snapshot.runs24h}`,
      `- Failures (24h): ${snapshot.failures24h}`,
      `- Success rate (24h): ${snapshot.successRate24h}%`,
    ].join('\n');

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    logStep?.({
      stage: 'dev_assist.status.posted',
      message: 'Posted dev-assist status snapshot in Slack thread.',
      data: snapshot,
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Posted dev-assist status snapshot.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'STATUS',
        ...snapshot,
      },
    };
  }

  if (command.type === 'RUNS') {
    const runs = store.listDevRuns(command.limit);
    const lines = runs.map((run, index) => {
      const shortId = run.id.slice(0, 8);
      return `${index + 1}. [${run.status}] ${run.workflow} job=${shortId} updated=${run.updatedAt}`;
    });

    const text = runs.length
      ? ['Recent runs:', ...lines].join('\n')
      : 'No runs found yet.';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    logStep?.({
      stage: 'dev_assist.runs.posted',
      message: 'Posted recent runs in Slack thread.',
      data: {
        limit: command.limit,
        returned: runs.length,
      },
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Posted recent runs.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'RUNS',
        limit: command.limit,
        count: runs.length,
      },
    };
  }

  if (command.type === 'FAILURES') {
    const runs = store.listDevRuns(command.limit, 'FAILED');
    const lines = runs.map((run, index) => {
      const shortId = run.id.slice(0, 8);
      return `${index + 1}. [${run.status}] ${run.workflow} job=${shortId} updated=${run.updatedAt}${
        run.errorMessage ? ` error=${run.errorMessage}` : ''
      }`;
    });

    const text = runs.length
      ? ['Recent failures:', ...lines].join('\n')
      : 'No failed runs found in recent history.';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    logStep?.({
      stage: 'dev_assist.failures.posted',
      message: 'Posted recent failed runs in Slack thread.',
      data: {
        limit: command.limit,
        returned: runs.length,
      },
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Posted recent failures.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'FAILURES',
        limit: command.limit,
        count: runs.length,
      },
    };
  }

  return {
    workflow: 'DEV_ASSIST',
    status: 'SKIPPED',
    message: 'Unsupported dev-assist command.',
    notifyDesktop: false,
    slackPosted: false,
  };
}
