import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runInformationalWorkflow } from '../src/workflows/informationalWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';
import { resolveWatchtowerPath } from '../src/workflows/shared/selfInquiryContext.js';
import type { WebClient } from '@slack/web-api';
import type { CodexRunResult } from '../src/types/contracts.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/slack/threadContext.js', () => ({
  fetchThreadContext: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/github/githubAuth.js', () => ({
  resolveGithubTokenForCodex: vi.fn().mockResolvedValue(undefined),
  githubAuthModeHint: vi.fn().mockReturnValue('none'),
}));

vi.mock('../src/slack/imageDownloader.js', () => ({
  downloadSlackImages: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/backends/registry.js', () => ({
  getBackend: vi.fn().mockReturnValue({ supportsImages: () => false }),
}));

vi.mock('../src/router/repoClassifier.js', () => ({
  classifyRepo: vi.fn().mockReturnValue({ selectedRepo: 'newton-web', confidence: 0.9, uncertain: false }),
}));

vi.mock('../src/workspaces/workspaceManager.js', () => ({
  resolveWorkspace: vi.fn((repoPath: string) => repoPath),
}));

vi.mock('../src/workflows/shared/selfInquiryContext.js', () => ({
  resolveWatchtowerPath: vi.fn().mockResolvedValue(undefined),
  buildLiveStateSnapshot: vi.fn().mockResolvedValue('## Live state snapshot\n- (mocked)'),
}));

function makeSlack() {
  return {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }) },
    users: { info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Test' } } }) },
  } as unknown as WebClient;
}

function codexOk(lastMessage: string): CodexRunResult {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: '',
    stderr: '',
    lastMessage,
    parsedJson: undefined,
  };
}

function codexFail(): CodexRunResult {
  return {
    ok: false,
    exitCode: 1,
    timedOut: false,
    stdout: '',
    stderr: 'error',
    lastMessage: '',
    parsedJson: undefined,
  };
}

const baseConfig = {
  platformPolicy: 'macos_only' as const,
  bundleTargets: ['app', 'dmg'] as const,
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  coreDevSlackUserGroup: '',
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01',
  allowedChannelsForBugFix: ['C01'],
  repoPaths: { newtonWeb: '/code/newton-web', newtonApi: '/code/newton-api' },
  unknownTaskPolicy: 'desktop_only' as const,
  uncertainRepoPolicy: 'desktop_only' as const,
  unmappedPrRepoPolicy: 'desktop_only' as const,
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
};

function makeTask(
  overrides: Partial<{
    channelId: string;
    threadTs: string;
    text: string;
    eventId: string;
    isOwnerAuthor: boolean;
    userId: string;
  }> = {},
) {
  return {
    event: {
      eventId: overrides.eventId ?? 'Ev1',
      channelId: overrides.channelId ?? 'C1',
      threadTs: overrides.threadTs ?? '1.1',
      eventTs: overrides.threadTs ?? '1.1',
      userId: overrides.userId ?? 'U1',
      text: overrides.text ?? '<@UBOT1> how does auth work?',
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot' as const,
    isOwnerAuthor: overrides.isOwnerAuthor ?? false,
    isCoreDevAuthor: false,
    intent: 'INFORMATIONAL' as const,
  };
}

describe('informationalWorkflow', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(resolveWatchtowerPath).mockReset();
    vi.mocked(resolveWatchtowerPath).mockResolvedValue(undefined);
  });

  it('fans out to both repos and combines answers with section headers', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce(codexOk('Frontend uses JWT tokens stored in cookies.'))
      .mockResolvedValueOnce(codexOk('Backend validates the token via /api/auth/verify.'));

    const slack = makeSlack();
    const result = await runInformationalWorkflow({ task: makeTask(), config: baseConfig, slack });

    expect(runCodex).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('*Frontend (newton-web):*');
    expect(result.message).toContain('*Backend (newton-api):*');
    expect(result.message).toContain('JWT tokens');
    expect(result.message).toContain('/api/auth/verify');
  });

  it('drops a section when one side returns NOT_APPLICABLE', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce(codexOk('The event is tracked in src/analytics/track.ts.'))
      .mockResolvedValueOnce(codexOk('NOT_APPLICABLE: no backend involvement for this event'));

    const slack = makeSlack();
    const result = await runInformationalWorkflow({ task: makeTask(), config: baseConfig, slack });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('src/analytics/track.ts');
    expect(result.message).not.toContain('Backend');
    expect(result.message).not.toContain('Frontend');
    expect(result.message).not.toContain('NOT_APPLICABLE');
  });

  it('still posts one side with an inconclusive note when the other fails', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce(codexOk('Here is the frontend answer.'))
      .mockRejectedValueOnce(new Error('boom'));

    const slack = makeSlack();
    const result = await runInformationalWorkflow({ task: makeTask(), config: baseConfig, slack });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('Could not search newton-api');
    expect(result.message).toContain('Here is the frontend answer.');
  });

  it('returns FAILED with fallback when both sides fail', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(codexFail()).mockResolvedValueOnce(codexFail());

    const slack = makeSlack();
    const result = await runInformationalWorkflow({ task: makeTask(), config: baseConfig, slack });

    expect(result.status).toBe('FAILED');
    expect(result.message).toContain('could not find a clear answer');
  });

  it('returns FAILED with the softer out-of-scope message when every outcome is NOT_APPLICABLE', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce(codexOk('NOT_APPLICABLE: unrelated to frontend'))
      .mockResolvedValueOnce(codexOk('NOT_APPLICABLE: unrelated to backend'));

    const slack = makeSlack();
    const result = await runInformationalWorkflow({ task: makeTask(), config: baseConfig, slack });

    expect(result.status).toBe('FAILED');
    expect(result.message).toContain("doesn't seem to map");
    expect(result.message).toContain('Frontend (newton-web)');
    expect(result.message).toContain('Backend (newton-api)');
    expect(result.message).not.toContain('could not find a clear answer');
  });

  it('runs single scoped codex when only one repo path is configured', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(codexOk('Single-repo answer.'));

    const slack = makeSlack();
    const config = { ...baseConfig, repoPaths: { newtonWeb: '/code/newton-web', newtonApi: '' } };
    const result = await runInformationalWorkflow({ task: makeTask(), config, slack });

    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('SUCCESS');
    expect(result.message).toBe('Single-repo answer.');
    expect(result.message).not.toContain('Frontend');
    expect(result.message).not.toContain('Backend');
  });

  it('falls back to a single unscoped codex run when no repo paths are configured', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(codexOk('Generic answer.'));

    const slack = makeSlack();
    const config = { ...baseConfig, repoPaths: { newtonWeb: '', newtonApi: '' } };
    const result = await runInformationalWorkflow({ task: makeTask(), config, slack });

    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('SUCCESS');
    expect(result.message).toBe('Generic answer.');
  });

  it('posts the reply to the correct Slack thread', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(codexOk('Frontend bit.')).mockResolvedValueOnce(codexOk('Backend bit.'));

    const slack = makeSlack();
    await runInformationalWorkflow({
      task: makeTask({ channelId: 'C_TARGET', threadTs: '999.888', eventId: 'Ev4' }),
      config: baseConfig,
      slack,
    });

    expect(slack.chat.postMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C_TARGET', thread_ts: '999.888' }),
    );
  });

  it('sends scoped prompts to each repo with its own cwd', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce(codexOk('Frontend answer.'))
      .mockResolvedValueOnce(codexOk('Backend answer.'));

    const slack = makeSlack();
    await runInformationalWorkflow({ task: makeTask(), config: baseConfig, slack });

    const calls = vi.mocked(runCodex).mock.calls;
    expect(calls).toHaveLength(2);
    const webCall = calls.find(c => c[0].cwd === '/code/newton-web');
    const apiCall = calls.find(c => c[0].cwd === '/code/newton-api');
    expect(webCall).toBeDefined();
    expect(apiCall).toBeDefined();
    expect(webCall?.[0].prompt).toContain('newton-web');
    expect(webCall?.[0].prompt).toContain('NOT_APPLICABLE');
    expect(apiCall?.[0].prompt).toContain('newton-api');
    expect(apiCall?.[0].prompt).toContain('NOT_APPLICABLE');
  });

  describe('self-inquiry target', () => {
    it('returns the self answer alone when both product repos abstain', async () => {
      vi.mocked(resolveWatchtowerPath).mockResolvedValue('/code/watchtower');
      vi.mocked(runCodex)
        .mockResolvedValueOnce(codexOk('NOT_APPLICABLE: not a frontend question'))
        .mockResolvedValueOnce(codexOk('NOT_APPLICABLE: not a backend question'))
        .mockResolvedValueOnce(codexOk('Figma MCP is not configured in `~/.claude.json`.'));

      const slack = makeSlack();
      const result = await runInformationalWorkflow({
        task: makeTask({ isOwnerAuthor: true }),
        config: baseConfig,
        slack,
      });

      expect(runCodex).toHaveBeenCalledTimes(3);
      expect(result.status).toBe('SUCCESS');
      expect(result.message).toBe('Figma MCP is not configured in `~/.claude.json`.');
      expect(result.message).not.toContain('Bot internals');
      expect(result.message).not.toContain('NOT_APPLICABLE');
    });

    it('combines all three sections in web → api → bot order when every target answers', async () => {
      vi.mocked(resolveWatchtowerPath).mockResolvedValue('/code/watchtower');
      vi.mocked(runCodex)
        .mockResolvedValueOnce(codexOk('Frontend bit.'))
        .mockResolvedValueOnce(codexOk('Backend bit.'))
        .mockResolvedValueOnce(codexOk('Bot bit.'));

      const slack = makeSlack();
      const result = await runInformationalWorkflow({
        task: makeTask({ isOwnerAuthor: true }),
        config: baseConfig,
        slack,
      });

      expect(result.status).toBe('SUCCESS');
      const webIdx = result.message?.indexOf('*Frontend (newton-web):*') ?? -1;
      const apiIdx = result.message?.indexOf('*Backend (newton-api):*') ?? -1;
      const selfIdx = result.message?.indexOf('*Bot internals (miniOG):*') ?? -1;
      expect(webIdx).toBeGreaterThanOrEqual(0);
      expect(apiIdx).toBeGreaterThan(webIdx);
      expect(selfIdx).toBeGreaterThan(apiIdx);
    });

    it('skips miniog-self fanout for non-owner authors and logs the reason', async () => {
      vi.mocked(resolveWatchtowerPath).mockResolvedValue('/code/watchtower');
      vi.mocked(runCodex)
        .mockResolvedValueOnce(codexOk('Frontend answer.'))
        .mockResolvedValueOnce(codexOk('Backend answer.'));

      const slack = makeSlack();
      const logStep = vi.fn();
      const result = await runInformationalWorkflow({
        task: makeTask({ isOwnerAuthor: false, userId: 'UADMIN' }),
        config: baseConfig,
        slack,
        logStep,
      });

      expect(runCodex).toHaveBeenCalledTimes(2);
      const cwds = vi.mocked(runCodex).mock.calls.map(c => c[0].cwd);
      expect(cwds).not.toContain('/code/watchtower');
      expect(result.status).toBe('SUCCESS');
      expect(result.message).not.toContain('Bot internals');

      const skipLog = logStep.mock.calls.find(([entry]) => entry.stage === 'informational.fanout.self.skipped');
      expect(skipLog).toBeDefined();
      expect(skipLog?.[0].data).toMatchObject({ reason: 'not_owner', userId: 'UADMIN' });
    });

    it('injects the live state snapshot into the self-inquiry prompt with the watchtower cwd', async () => {
      vi.mocked(resolveWatchtowerPath).mockResolvedValue('/code/watchtower');
      vi.mocked(runCodex)
        .mockResolvedValue(codexOk('NOT_APPLICABLE: pass-through'))
        .mockResolvedValueOnce(codexOk('Frontend answer.'))
        .mockResolvedValueOnce(codexOk('Backend answer.'))
        .mockResolvedValueOnce(codexOk('Self answer.'));

      const slack = makeSlack();
      await runInformationalWorkflow({
        task: makeTask({ isOwnerAuthor: true }),
        config: baseConfig,
        slack,
      });

      const calls = vi.mocked(runCodex).mock.calls;
      const selfCall = calls.find(c => c[0].cwd === '/code/watchtower');
      expect(selfCall).toBeDefined();
      expect(selfCall?.[0].prompt).toContain('Live state snapshot');
      expect(selfCall?.[0].prompt).toContain('miniOG / Watchtower **itself**');
      expect(selfCall?.[0].prompt).toContain('NOT_APPLICABLE');
    });

    it('falls through cleanly when self-inquiry abstains and a product repo answers', async () => {
      vi.mocked(resolveWatchtowerPath).mockResolvedValue('/code/watchtower');
      vi.mocked(runCodex)
        .mockResolvedValueOnce(codexOk('Frontend answer.'))
        .mockResolvedValueOnce(codexOk('NOT_APPLICABLE: backend not involved'))
        .mockResolvedValueOnce(codexOk('NOT_APPLICABLE: not a question about the bot'));

      const slack = makeSlack();
      const result = await runInformationalWorkflow({
        task: makeTask({ isOwnerAuthor: true }),
        config: baseConfig,
        slack,
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.message).toBe('Frontend answer.');
      expect(result.message).not.toContain('NOT_APPLICABLE');
      expect(result.message).not.toContain('Bot internals');
    });

    it('skips the self-inquiry target when no watchtower path can be resolved', async () => {
      vi.mocked(resolveWatchtowerPath).mockResolvedValue(undefined);
      vi.mocked(runCodex)
        .mockResolvedValueOnce(codexOk('NOT_APPLICABLE: unrelated to frontend'))
        .mockResolvedValueOnce(codexOk('NOT_APPLICABLE: unrelated to backend'));

      const slack = makeSlack();
      const result = await runInformationalWorkflow({ task: makeTask(), config: baseConfig, slack });

      expect(runCodex).toHaveBeenCalledTimes(2);
      expect(result.status).toBe('FAILED');
      expect(result.message).toContain("doesn't seem to map");
      expect(result.message).not.toContain('Bot internals');
    });
  });
});
