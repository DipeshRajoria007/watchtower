import { describe, expect, it } from 'vitest';
import { renderPromptTemplate } from '../src/workflows/renderer.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01H',
  allowedChannelsForBugFix: [],
  repoPaths: {
    newtonWeb: '/code/web',
    newtonApi: '/code/api',
  },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
  agentBackend: 'codex',
};

const task: NormalizedTask = {
  event: {
    eventId: 'Ev1',
    channelId: 'C123',
    threadTs: '111.22',
    eventTs: '111.22',
    userId: 'U789',
    text: 'deploy the frontend',
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  intent: 'UNKNOWN',
};

describe('renderPromptTemplate', () => {
  it('substitutes all template variables', () => {
    const template = 'User {{user_id}} in channel {{channel_id}} said: {{user_message}}. Web: {{repo_web}}, API: {{repo_api}}';
    const result = renderPromptTemplate(template, task, config);
    expect(result).toBe('User U789 in channel C123 said: deploy the frontend. Web: /code/web, API: /code/api');
  });

  it('handles template with no variables', () => {
    const result = renderPromptTemplate('static prompt', task, config);
    expect(result).toBe('static prompt');
  });

  it('handles multiple occurrences of same variable', () => {
    const result = renderPromptTemplate('{{user_id}} and {{user_id}}', task, config);
    expect(result).toBe('U789 and U789');
  });
});
