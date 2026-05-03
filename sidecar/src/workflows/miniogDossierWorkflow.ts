import type { WebClient } from '@slack/web-api';
import type { NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { formatDossierForHuman } from '../state/dossierStore.js';
import type { JobStore } from '../state/jobStore.js';

export async function runMiniogDossierWorkflow(params: {
  task: NormalizedTask;
  slack: WebClient;
  store: JobStore;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { task, slack, store, logStep } = params;
  const sub = task.miniogSubcommand;

  if (!sub) {
    return {
      workflow: 'MINIOG_DOSSIER',
      status: 'SKIPPED',
      message: 'No dossier subcommand on task; nothing to do.',
      notifyDesktop: false,
      slackPosted: false,
    };
  }

  const userId = task.event.userId;
  const dossiers = store.dossierStore();
  const channel = task.event.channelId;
  const threadTs = task.event.threadTs;

  async function reply(text: string): Promise<void> {
    await slack.chat.postMessage({ channel, thread_ts: threadTs, text });
  }

  if (sub.kind === 'whoami') {
    let displayName: string | undefined;
    let realName: string | undefined;
    let tz: string | undefined;
    let email: string | undefined;
    try {
      const info = await slack.users.info({ user: userId });
      displayName = info.user?.profile?.display_name || undefined;
      realName = info.user?.real_name || info.user?.profile?.real_name || undefined;
      tz = info.user?.tz || undefined;
      email = info.user?.profile?.email || undefined;
      dossiers.firstSeen({ userId, displayName, realName, tz, email });
    } catch (err) {
      logStep?.({
        stage: 'miniog.dossier.users_info_failed',
        level: 'WARN',
        message: 'users.info lookup failed during whoami; falling back to stored dossier only.',
        data: { error: (err as Error).message },
      });
    }

    const dossier = dossiers.getDossier(userId);
    const pinnedFacts = dossiers.listPinnedFacts(userId);
    const body =
      formatDossierForHuman(dossier, { pinnedFacts }) ??
      "I don't have a dossier for you yet — interact with me a bit and try again.";
    await reply(body);

    logStep?.({
      stage: 'miniog.dossier.whoami',
      message: 'Posted whoami summary.',
      data: { hasProfile: dossier.profile !== null, affinityRows: dossier.affinity.length },
    });

    return {
      workflow: 'MINIOG_DOSSIER',
      status: 'SUCCESS',
      message: 'Posted dossier summary.',
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (sub.kind === 'set-role') {
    dossiers.setRole(userId, sub.role);
    await reply(`Got it — I'll treat you as a *${sub.role}* from now on.`);
    logStep?.({
      stage: 'miniog.dossier.set_role',
      message: `Role set to ${sub.role}`,
      data: { role: sub.role },
    });
    return {
      workflow: 'MINIOG_DOSSIER',
      status: 'SUCCESS',
      message: `Role set to ${sub.role}.`,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (sub.kind === 'forget') {
    // `forget all` is the destructive whole-dossier wipe — gated to the owner
    // so individual users can't (accidentally or otherwise) delete the
    // history miniOG has accumulated for them. Per-field forgets (role,
    // tone, notes, project_affinity, metrics) remain self-editable since
    // those are normal privacy hygiene, not a data wipe.
    if (sub.field === 'all' && !task.isOwnerAuthor) {
      await reply(
        'Sorry, only the owner can wipe a full dossier. You can still clear individual fields with `forget role`, `forget tone`, or `forget notes`.',
      );
      logStep?.({
        stage: 'miniog.dossier.forget.denied',
        level: 'WARN',
        message: 'Non-owner attempted forget all; denied.',
        data: { field: sub.field, requesterId: userId },
      });
      return {
        workflow: 'MINIOG_DOSSIER',
        status: 'SKIPPED',
        message: 'Forget-all denied: owner-only.',
        notifyDesktop: false,
        slackPosted: true,
      };
    }
    if (sub.field === 'all' && !sub.confirmed) {
      await reply(
        "That wipes your entire dossier (profile, role, tone, affinity, metrics). Reply with `forget all confirm` if you're sure.",
      );
      return {
        workflow: 'MINIOG_DOSSIER',
        status: 'SKIPPED',
        message: 'Forget-all requested without confirmation.',
        notifyDesktop: false,
        slackPosted: true,
      };
    }

    dossiers.forgetField(userId, sub.field);
    const message = sub.field === 'all' ? 'Dossier wiped.' : `Forgot ${sub.field.replace('_', ' ')}.`;
    await reply(message);
    logStep?.({
      stage: 'miniog.dossier.forget',
      message,
      data: { field: sub.field },
    });
    return {
      workflow: 'MINIOG_DOSSIER',
      status: 'SUCCESS',
      message,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (sub.kind === 'remember') {
    const result = dossiers.addPinnedFact({
      userId,
      text: sub.text,
      source: 'slack-remember',
    });
    if (!result) {
      await reply('I need something to remember — try `remember dashboard rewrite started 2026-04-15`.');
      return {
        workflow: 'MINIOG_DOSSIER',
        status: 'SKIPPED',
        message: 'Remember rejected: empty text.',
        notifyDesktop: false,
        slackPosted: true,
      };
    }
    const lines = [`Got it — I'll remember: _${result.row.text}_ (id ${result.row.id}).`];
    if (result.rotatedOut) {
      lines.push(`Rotated out the oldest entry to stay under your ${50}-fact cap: _${result.rotatedOut.text}_.`);
    }
    await reply(lines.join('\n'));
    logStep?.({
      stage: 'miniog.dossier.remember',
      message: 'Pinned fact added.',
      data: { id: result.row.id, rotatedOutId: result.rotatedOut?.id ?? null },
    });
    return {
      workflow: 'MINIOG_DOSSIER',
      status: 'SUCCESS',
      message: 'Pinned fact added.',
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (sub.kind === 'memories') {
    const facts = dossiers.listPinnedFacts(userId);
    if (facts.length === 0) {
      await reply("You haven't asked me to remember anything yet — try `remember <something>`.");
      return {
        workflow: 'MINIOG_DOSSIER',
        status: 'SUCCESS',
        message: 'Empty memories.',
        notifyDesktop: false,
        slackPosted: true,
      };
    }
    const body = [
      "Here's what you've asked me to remember:",
      ...facts.map(f => `[${f.id}] ${f.text}`),
      '',
      'Forget any with `forget memory <id>`.',
    ].join('\n');
    await reply(body);
    return {
      workflow: 'MINIOG_DOSSIER',
      status: 'SUCCESS',
      message: `Listed ${facts.length} pinned facts.`,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (sub.kind === 'forget-memory') {
    const removed = dossiers.removePinnedFact(userId, sub.id);
    if (!removed) {
      await reply(`No pinned fact with id ${sub.id} for you. Try \`memories\` to see your ids.`);
      return {
        workflow: 'MINIOG_DOSSIER',
        status: 'SKIPPED',
        message: `Pinned fact ${sub.id} not found.`,
        notifyDesktop: false,
        slackPosted: true,
      };
    }
    await reply(`Forgot pinned fact ${sub.id}.`);
    logStep?.({
      stage: 'miniog.dossier.forget_memory',
      message: `Removed pinned fact ${sub.id}`,
      data: { id: sub.id },
    });
    return {
      workflow: 'MINIOG_DOSSIER',
      status: 'SUCCESS',
      message: `Removed pinned fact ${sub.id}.`,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  return {
    workflow: 'MINIOG_DOSSIER',
    status: 'SKIPPED',
    message: 'Unhandled dossier subcommand.',
    notifyDesktop: false,
    slackPosted: false,
  };
}
