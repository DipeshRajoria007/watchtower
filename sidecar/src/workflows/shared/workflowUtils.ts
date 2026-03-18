import os from 'node:os';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowStepLogger } from '../../types/contracts.js';
import { fetchThreadContext } from '../../slack/threadContext.js';
import { downloadSlackImages } from '../../slack/imageDownloader.js';
import type { SlackFileAttachment } from '../../slack/imageDownloader.js';
import { classifyRepo } from '../../router/repoClassifier.js';
import { getBackend } from '../../backends/registry.js';
import { getActiveBackendId } from '../../codex/runCodex.js';
import { resolveGithubTokenForCodex } from '../../github/githubAuth.js';
import { resolveWorkspace } from '../../workspaces/workspaceManager.js';

export interface ThreadMessage {
  text: string;
  user: string;
  ts: string;
  files?: Array<Record<string, unknown>>;
}

export interface WorkflowContext {
  threadMessages: ThreadMessage[];
  threadContext: string;
  userInput: string;
  cwd: string;
  repoName?: string;
  isOwnerAuthor: boolean;
  requestedBy?: string;
  imagePaths: string[];
  imageContext: string;
  githubToken?: string;
}

export function formatThreadContext(
  task: NormalizedTask,
  messages: Array<{ text: string; user: string; ts: string }>,
): string {
  const lines: string[] = [];
  lines.push(`[root] user=${task.event.userId} ts=${task.event.eventTs}`);
  lines.push(task.event.text);

  for (const message of messages) {
    lines.push(`---`);
    lines.push(`[thread] user=${message.user} ts=${message.ts}`);
    lines.push(message.text);
  }

  return lines.join('\n');
}

export function stripMentions(text: string): string {
  return text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isPresencePing(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[!?.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return true;
  }

  return [
    /^you there$/,
    /^are you there$/,
    /^can you hear me$/,
    /^ping$/,
    /^hi$/,
    /^hello$/,
    /^hey$/,
    /^yo$/,
    /^online$/,
    /^awake$/,
    /^alive$/,
  ].some(pattern => pattern.test(normalized));
}

export function buildPresenceReply(eventTs: string): string {
  const variants = [
    "Yeah, I'm here. Drop the agenda item.",
    'Online and listening. Tell me what should move first.',
    'Present. Send the ask and I will handle the paperwork and the work.',
  ];

  let hash = 0;
  for (let i = 0; i < eventTs.length; i += 1) {
    hash = (hash * 31 + eventTs.charCodeAt(i)) >>> 0;
  }
  return variants[hash % variants.length];
}

export function sanitizeOwnerSummary(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  let cleaned = normalized
    .replace(/on\s+master'?s?\s+command[,:\-\s]*overriding\s+watchtower\s+guardrails\.?/gi, '')
    .replace(/overriding\s+watchtower\s+guardrails\.?/gi, '')
    .replace(/^master your task is completed\.?\s*/i, '')
    .replace(/^owner request success\.?\s*/i, '')
    .replace(/^request success\.?\s*/i, '');

  cleaned = cleaned.replace(/\bactions?:[\s\S]*$/i, '');
  cleaned = cleaned
    .replace(/\b(posted|replied|verified|confirmed)\b[^.\n]*(slack|thread|channel|timestamp)[^.\n]*\.?/gi, '')
    .replace(/\bowner.?s?\s+slack\s+thread\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const lines = cleaned
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^actions?:/i.test(line))
    .filter(line => !/^-\s*/.test(line))
    .filter(
      line =>
        !/(channel\s+[A-Z0-9]+|thread\s+\d+\.\d+|timestamp|slack thread|replied in slack|posted in slack|confirmed slack)/i.test(
          line,
        ),
    )
    .filter(line => !/^on master's command/i.test(line));

  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

export function resolveOwnerWorkspaceRoot(config: AppConfig): string {
  const webParent = path.dirname(config.repoPaths.newtonWeb);
  const apiParent = path.dirname(config.repoPaths.newtonApi);
  if (webParent === apiParent) {
    return webParent;
  }
  return process.env.HOME ?? os.homedir();
}

export async function prepareWorkflowContext(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  resolveRepo?: boolean;
}): Promise<WorkflowContext> {
  const { task, config, slack, logStep, resolveRepo = true } = params;
  const isOwnerAuthor = config.ownerSlackUserIds.includes(task.event.userId);

  // Resolve Slack display name
  let requestedBy: string | undefined;
  try {
    const userInfo = await slack.users.info({ user: task.event.userId });
    requestedBy =
      userInfo.user?.profile?.display_name ||
      userInfo.user?.profile?.real_name ||
      userInfo.user?.real_name ||
      userInfo.user?.name;
  } catch {
    // Non-fatal
  }

  // Fetch thread context
  const threadMessages = (await fetchThreadContext(slack, task.event.channelId, task.event.threadTs).catch(
    () => [],
  )) as ThreadMessage[];
  const threadContext = formatThreadContext(task, threadMessages);
  const userInput = stripMentions(task.event.text);

  // Resolve working directory
  let cwd: string;
  let repoName: string | undefined;

  if (!resolveRepo) {
    cwd = os.tmpdir();
  } else if (isOwnerAuthor) {
    cwd = resolveOwnerWorkspaceRoot(config);
  } else {
    const texts = [task.event.text, ...threadMessages.map(m => m.text)];
    const classification = classifyRepo(texts, config.repoClassifierThreshold);

    logStep?.({
      stage: 'workflow.repo.classified',
      message: 'Classified repository for execution.',
      data: {
        selectedRepo: classification.selectedRepo,
        confidence: classification.confidence,
        uncertain: classification.uncertain,
      },
    });

    if (classification.uncertain || !classification.selectedRepo) {
      cwd = os.tmpdir();
    } else {
      repoName = classification.selectedRepo;
      const baseRepoPath =
        classification.selectedRepo === 'newton-web' ? config.repoPaths.newtonWeb : config.repoPaths.newtonApi;
      cwd = resolveWorkspace(baseRepoPath, task.event.threadTs);
    }
  }

  // Download images
  const allFiles = threadMessages.flatMap((m: ThreadMessage) => m.files ?? []) as unknown as SlackFileAttachment[];
  let imagePaths: string[] = [];
  if (allFiles.length > 0) {
    try {
      imagePaths = await downloadSlackImages({
        files: allFiles,
        botToken: config.slackBotToken,
      });
    } catch {
      // Non-fatal
    }
  }

  const backend = getBackend(getActiveBackendId());
  const imageContext =
    imagePaths.length > 0 && !backend.supportsImages()
      ? `\n\n[${imagePaths.length} image(s) attached in thread — this backend does not support image input]`
      : '';

  // Resolve GitHub token
  const githubToken = await resolveGithubTokenForCodex();

  return {
    threadMessages,
    threadContext,
    userInput,
    cwd,
    repoName,
    isOwnerAuthor,
    requestedBy,
    imagePaths,
    imageContext,
    githubToken,
  };
}
