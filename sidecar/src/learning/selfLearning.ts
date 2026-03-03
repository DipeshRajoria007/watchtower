import type {
  AppConfig,
  NormalizedTask,
  PersonalityMode,
  WorkflowIntent,
  WorkflowStepLogger,
} from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';

const REVIEW_KEYWORDS = [/review/i, /pr\b/i, /pull request/i, /code review/i];
const BUG_KEYWORDS = [/bug/i, /fix/i, /broken/i, /error/i, /failing/i, /regression/i, /crash/i, /issue/i];
const CORRECTION_CUE = /\b(actually|instead|wrong|not this|no,|retry|again)\b/i;

type PersonalityDirective = {
  mode: PersonalityMode;
  applyToChannel: boolean;
  reason: string;
};

export type LearningResult = {
  intent: WorkflowIntent;
  correctionApplied: boolean;
  personalityMode: PersonalityMode;
  notes: string[];
};

export function applyLearning(input: {
  task: NormalizedTask;
  config: AppConfig;
  store: JobStore;
  logStep?: WorkflowStepLogger;
}): LearningResult {
  const { task, config, store, logStep } = input;

  const notes: string[] = [];
  let intent = task.intent;
  let correctionApplied = false;

  const directive = detectPersonalityDirective(task.event.text);
  if (directive) {
    store.setPersonalityProfile({
      scope: 'user',
      scopeId: task.event.userId,
      mode: directive.mode,
      source: directive.reason,
    });
    if (directive.applyToChannel) {
      store.setPersonalityProfile({
        scope: 'channel',
        scopeId: task.event.channelId,
        mode: directive.mode,
        source: directive.reason,
      });
    }
    notes.push(
      directive.applyToChannel
        ? `updated personality to ${directive.mode} for user+channel`
        : `updated personality to ${directive.mode} for user`
    );
    logStep?.({
      stage: 'learning.personality.updated',
      message: 'Updated personality profile from user instruction.',
      data: {
        mode: directive.mode,
        applyToChannel: directive.applyToChannel,
      },
    });
  }

  const personalityMode = store.getPersonalityMode({
    channelId: task.event.channelId,
    userId: task.event.userId,
  });

  const phraseKey = normalizePhraseKey(task.event.text);
  const explicitIntent = detectExplicitIntent(task.event.text, task.event.channelId, config);
  const latest = store.latestJobForThread(task.event.channelId, task.event.threadTs);

  if (
    explicitIntent &&
    latest &&
    latest.workflow !== explicitIntent &&
    (CORRECTION_CUE.test(task.event.text) || latest.workflow === 'UNKNOWN')
  ) {
    store.saveIntentCorrection({
      channelId: task.event.channelId,
      userId: task.event.userId,
      phraseKey,
      correctedIntent: explicitIntent,
    });

    notes.push(`learned correction ${latest.workflow} -> ${explicitIntent}`);
    logStep?.({
      stage: 'learning.intent.learned',
      message: 'Learned a new intent correction from thread feedback.',
      data: {
        previousIntent: latest.workflow,
        correctedIntent: explicitIntent,
        phraseKey,
      },
    });
  }

  if (intent !== 'OWNER_AUTOPILOT') {
    const corrected = store.findIntentCorrection({
      channelId: task.event.channelId,
      userId: task.event.userId,
      phraseKey,
    });
    if (corrected && corrected !== intent) {
      intent = corrected;
      correctionApplied = true;
      notes.push(`applied learned correction -> ${corrected}`);
      logStep?.({
        stage: 'learning.intent.applied',
        message: 'Applied learned intent correction.',
        data: {
          correctedIntent: corrected,
          phraseKey,
        },
      });
    }
  }

  return {
    intent,
    correctionApplied,
    personalityMode,
    notes,
  };
}

function detectExplicitIntent(text: string, channelId: string, config: AppConfig): WorkflowIntent | undefined {
  if (REVIEW_KEYWORDS.some(regex => regex.test(text))) {
    return 'PR_REVIEW';
  }
  if (BUG_KEYWORDS.some(regex => regex.test(text)) && config.allowedChannelsForBugFix.includes(channelId)) {
    return 'BUG_FIX';
  }
  return undefined;
}

function normalizePhraseKey(text: string): string {
  return text
    .replace(/<@[^>]+>/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2)
    .slice(0, 10)
    .join(' ');
}

function detectPersonalityDirective(text: string): PersonalityDirective | undefined {
  const normalized = text.toLowerCase();
  const applyToChannel = /\b(this channel|channel wide|channel-wide|for everyone here|here)\b/i.test(text);

  if (/\b(professional|serious|formal|no jokes|strict)\b/.test(normalized)) {
    return { mode: 'professional', applyToChannel, reason: 'directive:professional' };
  }
  if (/\b(friendly|polite|calm|kind)\b/.test(normalized)) {
    return { mode: 'friendly', applyToChannel, reason: 'directive:friendly' };
  }
  if (/\b(chaos|chaotic|unhinged)\b/.test(normalized)) {
    return { mode: 'chaos', applyToChannel, reason: 'directive:chaos' };
  }
  if (/\b(dark humor|dark humour|dark mode replies|sus|roast)\b/.test(normalized)) {
    return { mode: 'dark_humor', applyToChannel, reason: 'directive:dark_humor' };
  }
  return undefined;
}

