import os from 'node:os';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { extractReplyFromCodexResult } from './shared/workflowUtils.js';

function buildWebflowPrompt(task: NormalizedTask): string {
  return `
${buildMentionSystemPrompt({ task, workflow: 'WEBFLOW_EDIT', toneMode: task.toneMode, dossierRole: task.dossierRole })}

You are handling a Webflow site edit request from Slack.

Tool access:
- The Webflow MCP server is registered for this Claude Code session (see \`~/.claude.json\` → \`mcpServers.webflow\`).
- Its tools are exposed under the \`webflow\` namespace and cover:
  - Sites — list sites, get details, publish to custom domains.
  - CMS — list collections, read schemas, CRUD collection items, publish drafted items.
  - Pages — list pages, read/update page metadata (title, slug, SEO, Open Graph).
  - Assets — upload, organize, alt text, folders.
  - Components — list and manage reusable components.
  - Custom code — list / register / delete site scripts.
  - Designer (canvas) — create elements, manage styles, classes, variables, breakpoints. **Only works while the Webflow Designer is open in the user's browser with the MCP Bridge App enabled.**
- If a tool call fails because the Webflow Designer Bridge isn't open, say so plainly and ask the user to open it instead of guessing.

Operating rules:
1. Start by reading before writing. Use list/read tools to find the site, page, or collection the user named, then confirm the right target.
2. Apply the smallest change that satisfies the request. Don't reorganize or "tidy" unrelated content.
3. Only call \`webflow_publish_site\` (or equivalent publish tool) if the user explicitly asked you to publish. Otherwise leave changes as drafts and tell them how to publish.
4. If you can't find the target (no matching site/page/collection/item), stop and report what you did find — do NOT create new resources unless the user asked for that.
5. Never write code changes to this repo. There is no git working tree to edit; \`cwd\` is a scratch tmpdir.

Output rules:
Your response will be posted to a Slack thread. Reply with a clean, concise human message:
- What you changed (target name + before → after).
- Whether it was published or left as a draft.
- A link to the page in the Webflow Designer / live URL if the tools returned one.
- On failure: the user-facing reason and the next step they should take.

Do NOT include JSON, code fences for tool output, raw tool ids, or step-by-step telemetry.
`.trim();
}

export async function runWebflowEditWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, slack, logStep, signal } = params;

  logStep?.({
    stage: 'webflow.start',
    message: 'Running Webflow edit workflow.',
    data: { backend: getActiveBackendId() },
  });

  await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: 'Working on your Webflow site…',
    })
    .catch(() => {});

  const prompt = buildWebflowPrompt(task);

  const result = await runCodex({
    cwd: os.tmpdir(),
    prompt,
    ...highReasoningProfile(getActiveBackendId()),
    onLog: logStep,
    signal,
  });

  logStep?.({
    stage: 'webflow.codex.done',
    message: 'Webflow workflow agent finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: { ok: result.ok, exitCode: result.exitCode },
  });

  const reply =
    extractReplyFromCodexResult(result) ||
    "I finished the Webflow workflow but didn't get any output back. Check the job logs.";

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: reply,
  });

  return {
    workflow: 'WEBFLOW_EDIT',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    message: reply,
    notifyDesktop: true,
    slackPosted: true,
  };
}
