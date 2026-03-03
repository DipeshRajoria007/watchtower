import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { parseDevAssistCommand } from '../router/devAssistParser.js';

const HELP_TEXT = [
  'Watchtower Dev Assistant commands:',
  '- `wt help` -> show command help',
  '',
  'More commands are being added in the next updates.',
].join('\n');

export async function runDevAssistWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, slack, logStep } = params;

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

  return {
    workflow: 'DEV_ASSIST',
    status: 'SKIPPED',
    message: 'Unsupported dev-assist command.',
    notifyDesktop: false,
    slackPosted: false,
  };
}
