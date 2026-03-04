import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { diagnoseFailure } from '../learning/failureDoctor.js';
import { parseDevAssistCommand } from '../router/devAssistParser.js';
import type { JobStore } from '../state/jobStore.js';

const HELP_TEXT = [
  'Watchtower Dev Assistant commands:',
  '- `wt help` -> show command help',
  '- `wt status` -> show current runtime health snapshot',
  '- `wt runs [n]` -> show latest runs (default 5)',
  '- `wt failures [n]` -> show latest failed runs (default 5)',
  '- `wt trace <jobId> [lines]` -> show recent trace lines for a job',
  '- `wt diagnose <jobId>` -> run Failure Doctor diagnosis on a job',
  '- `wt learn` -> show learning engine stats',
  '- `wt heat [n]` -> show top active channels in last 7 days',
  '- `wt personality set <mode> [channel|me]` -> set reply tone profile',
  '- `wt personality show [channel|me]` -> show current tone profile',
  '- `wt mission start <goal>` -> start/update mission state for this thread',
  '- `wt mission show` -> show mission state for this thread',
  '- `wt mission run --swarm` -> launch planner/coder/reviewer/shipper run',
  '- `wt trust <channel|user> <observe|suggest|execute|merge>` -> set approval gate',
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

  if (command.type === 'TRACE') {
    const resolvedJobId = store.resolveJobId(command.jobId);
    if (!resolvedJobId) {
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: `Could not find job \`${command.jobId}\`. Use \`wt runs\` or \`wt failures\` to copy a valid job id.`,
      });

      return {
        workflow: 'DEV_ASSIST',
        status: 'SKIPPED',
        message: 'Trace lookup failed: unknown job id.',
        notifyDesktop: false,
        slackPosted: true,
      };
    }

    const logs = store.listJobLogsTail(resolvedJobId, command.limit);
    const lines = logs.map(log => {
      return `[${log.level}] ${log.stage} - ${log.message}`;
    });

    const text = logs.length
      ? [`Trace for job ${resolvedJobId}:`, ...lines].join('\n')
      : `No trace logs found for job ${resolvedJobId}.`;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    logStep?.({
      stage: 'dev_assist.trace.posted',
      message: 'Posted job trace snippet in Slack thread.',
      data: {
        jobId: resolvedJobId,
        requested: command.limit,
        returned: logs.length,
      },
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Posted job trace.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'TRACE',
        jobId: resolvedJobId,
        count: logs.length,
      },
    };
  }

  if (command.type === 'DIAGNOSE') {
    const resolvedJobId = store.resolveJobId(command.jobId);
    if (!resolvedJobId) {
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: `Could not find job \`${command.jobId}\` for diagnosis.`,
      });

      return {
        workflow: 'DEV_ASSIST',
        status: 'SKIPPED',
        message: 'Diagnosis lookup failed: unknown job id.',
        notifyDesktop: false,
        slackPosted: true,
      };
    }

    const job = store.getJobSummary(resolvedJobId);
    const logs = store.listJobLogsTail(resolvedJobId, 200).map(log => ({
      level: log.level,
      stage: log.stage,
      message: log.message,
      data: undefined,
    }));

    const diagnosis = diagnoseFailure({
      workflow: job?.workflow ?? 'UNKNOWN',
      message: job?.errorMessage ?? `${job?.status ?? 'UNKNOWN'}`,
      logs,
    });

    const text = diagnosis
      ? [
          `Failure diagnosis for ${resolvedJobId}:`,
          `- Kind: ${diagnosis.errorKind}`,
          `- Summary: ${diagnosis.summary}`,
          ...diagnosis.actions.slice(0, 3).map(action => `- Fix: ${action}`),
        ].join('\n')
      : `No strong diagnosis found for ${resolvedJobId}. Try \`wt trace ${resolvedJobId} 40\` for deeper context.`;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    logStep?.({
      stage: 'dev_assist.diagnose.posted',
      message: 'Posted Failure Doctor diagnosis in Slack thread.',
      data: {
        jobId: resolvedJobId,
        diagnosed: Boolean(diagnosis),
      },
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Posted failure diagnosis.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'DIAGNOSE',
        jobId: resolvedJobId,
        diagnosed: Boolean(diagnosis),
        errorKind: diagnosis?.errorKind,
      },
    };
  }

  if (command.type === 'LEARN') {
    const snapshot = store.getDevLearningSnapshot();
    const text = [
      'Learning engine snapshot:',
      `- Signals (24h): ${snapshot.signals24h}`,
      `- Corrections learned: ${snapshot.correctionsLearned}`,
      `- Corrections applied (24h): ${snapshot.correctionsApplied24h}`,
      `- Personality profiles: ${snapshot.personalityProfiles}`,
      `- Top failure pattern: ${snapshot.topErrorKind}`,
    ].join('\n');

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    logStep?.({
      stage: 'dev_assist.learn.posted',
      message: 'Posted learning engine snapshot in Slack thread.',
      data: snapshot,
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Posted learning snapshot.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'LEARN',
        ...snapshot,
      },
    };
  }

  if (command.type === 'HEAT') {
    const heat = store.getDevChannelHeat(command.limit);
    const lines = heat.map((item, index) => {
      return `${index + 1}. ${item.channelId} runs=${item.runs} failures=${item.failures}`;
    });

    const text = heat.length
      ? ['Channel heat (last 7 days):', ...lines].join('\n')
      : 'No channel activity found for the last 7 days.';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    logStep?.({
      stage: 'dev_assist.heat.posted',
      message: 'Posted channel heat snapshot in Slack thread.',
      data: {
        limit: command.limit,
        returned: heat.length,
      },
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Posted channel heat.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'HEAT',
        limit: command.limit,
        count: heat.length,
      },
    };
  }

  if (command.type === 'PERSONALITY_SET') {
    const scopeId = command.scope === 'channel' ? task.event.channelId : task.event.userId;
    store.setPersonalityProfile({
      scope: command.scope,
      scopeId,
      mode: command.mode,
      source: 'dev_assist_command',
    });

    const target = command.scope === 'channel' ? `channel ${task.event.channelId}` : `user ${task.event.userId}`;
    const text = `Personality updated: \`${command.mode}\` for ${target}.`;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    logStep?.({
      stage: 'dev_assist.personality_set.posted',
      message: 'Updated personality profile via dev-assist command.',
      data: {
        scope: command.scope,
        scopeId,
        mode: command.mode,
      },
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Updated personality profile.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'PERSONALITY_SET',
        scope: command.scope,
        scopeId,
        mode: command.mode,
      },
    };
  }

  if (command.type === 'PERSONALITY_SHOW') {
    const scopeId = command.scope === 'channel' ? task.event.channelId : task.event.userId;
    const direct = store.getPersonalityProfile({
      scope: command.scope,
      scopeId,
    });
    const fallback = store.getPersonalityMode({
      channelId: task.event.channelId,
      userId: task.event.userId,
    });

    const effective = direct ?? fallback;
    const text = direct
      ? `Current personality for ${command.scope} ${scopeId}: \`${effective}\``
      : `No explicit ${command.scope} profile found. Effective personality right now: \`${effective}\``;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    logStep?.({
      stage: 'dev_assist.personality_show.posted',
      message: 'Posted personality profile snapshot in Slack thread.',
      data: {
        scope: command.scope,
        scopeId,
        mode: effective,
        explicit: Boolean(direct),
      },
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Posted personality profile.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'PERSONALITY_SHOW',
        scope: command.scope,
        scopeId,
        mode: effective,
        explicit: Boolean(direct),
      },
    };
  }

  if (command.type === 'MISSION_START') {
    const mission = store.upsertMissionStart({
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      goal: command.goal,
      ownerUserId: task.event.userId,
    });

    const text = [
      `Mission initialized for this thread.`,
      `- id: ${mission.id}`,
      `- goal: ${command.goal}`,
      '- status: ACTIVE',
      '- progress: Not started',
      '- blockers: None',
      '- eta: TBD',
    ].join('\n');

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    logStep?.({
      stage: 'dev_assist.mission.start',
      message: 'Started mission thread state.',
      data: {
        missionId: mission.id,
      },
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Mission started.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'MISSION_START',
        missionId: mission.id,
      },
    };
  }

  if (command.type === 'MISSION_SHOW') {
    const mission = store.getMissionThread({
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
    });

    const text = mission
      ? [
          `Mission state for this thread:`,
          `- id: ${mission.id}`,
          `- goal: ${mission.goal}`,
          `- status: ${mission.status}`,
          `- progress: ${mission.progress}`,
          `- blockers: ${mission.blockers}`,
          `- eta: ${mission.eta}`,
          `- owner: <@${mission.ownerUserId}>`,
          `- updated: ${mission.updatedAt}`,
        ].join('\n')
      : 'No mission is active for this thread. Use `wt mission start <goal>`.';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Mission state posted.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'MISSION_SHOW',
        found: Boolean(mission),
      },
    };
  }

  if (command.type === 'MISSION_RUN_SWARM') {
    const run = store.startMissionSwarmRun({
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      requestedBy: task.event.userId,
    });

    const text = run
      ? [
          'Mission swarm execution started.',
          `- runId: ${run.runId}`,
          `- missionId: ${run.missionId}`,
          `- roles: ${run.roles.join(', ')}`,
        ].join('\n')
      : 'No mission found for this thread. Start one with `wt mission start <goal>` first.';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    return {
      workflow: 'DEV_ASSIST',
      status: run ? 'SUCCESS' : 'PAUSED',
      message: run ? 'Mission swarm started.' : 'Mission not found for swarm run.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'MISSION_RUN_SWARM',
        started: Boolean(run),
        runId: run?.runId,
      },
    };
  }

  if (command.type === 'TRUST_SET') {
    const targetId = command.target === 'channel' ? task.event.channelId : task.event.userId;
    store.setTrustPolicy({
      targetType: command.target,
      targetId,
      trustLevel: command.level,
      updatedBy: task.event.userId,
    });

    const text = `Trust policy updated: ${command.target} ${targetId} -> ${command.level}`;
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });

    return {
      workflow: 'DEV_ASSIST',
      status: 'SUCCESS',
      message: 'Trust policy updated.',
      notifyDesktop: false,
      slackPosted: true,
      result: {
        command: 'TRUST_SET',
        target: command.target,
        targetId,
        level: command.level,
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
