import { useEffect, useMemo, useRef, useState } from 'react';
import type { SlackCommandTarget } from '../types';

const SLACK_TARGETS: Array<{ command: string; description: string; label: string; value: SlackCommandTarget }> = [
  {
    value: 'miniog',
    label: 'miniOG',
    command: '/miniog',
    description: 'Personal developer assistant for free-form execution and drafting.',
  },
  {
    value: 'watchtower',
    label: 'Watchtower',
    command: '/wt',
    description: 'Operational assistant for runtime status, traces, failures, and learning heat.',
  },
];

const PROMPT_PRESETS = [
  {
    label: 'Review PR',
    prompt: 'Review this PR and summarize blockers before I request human review.',
  },
  {
    label: 'Diagnose run',
    prompt: 'Diagnose the latest failed run and tell me the fastest next step.',
  },
  {
    label: 'Plan feature',
    prompt: 'Draft an implementation plan for this feature with risks and sequencing.',
  },
  {
    label: 'Channel heat',
    prompt: 'Summarize channel heat and tell me where I should intervene first.',
  },
  {
    label: 'Draft reply',
    prompt: 'Draft a concise Slack reply that acknowledges the issue, explains the next step, and asks for the missing detail.',
  },
];

type SlackLaunchpadProps = {
  draft: string;
  focusToken: number;
  onDraftChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  onTargetChange: (value: SlackCommandTarget) => void;
  settingsRequired: boolean;
  submitting: boolean;
  target: SlackCommandTarget;
  variant?: 'default' | 'minimal';
};

export function SlackLaunchpad({
  draft,
  focusToken,
  onDraftChange,
  onSubmit,
  onTargetChange,
  settingsRequired,
  submitting,
  target,
  variant = 'default',
}: SlackLaunchpadProps) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isMinimal = variant === 'minimal';
  const isMiniOg = target === 'miniog';
  const trimmedDraft = draft.trim();
  const canRunMiniOg = isMiniOg && trimmedDraft.length > 0 && !submitting && !settingsRequired;

  const selectedTarget = useMemo(() => {
    return SLACK_TARGETS.find(item => item.value === target) ?? SLACK_TARGETS[0];
  }, [target]);

  const commandPreview = trimmedDraft
    ? `${selectedTarget.command} ${trimmedDraft}`
    : `${selectedTarget.command} <task>`;

  useEffect(() => {
    if (!focusToken) {
      return;
    }
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(textareaRef.current.value.length, textareaRef.current.value.length);
  }, [focusToken]);

  useEffect(() => {
    if (!feedback) {
      return;
    }
    const timeout = window.setTimeout(() => setFeedback(null), 1800);
    return () => window.clearTimeout(timeout);
  }, [feedback]);

  const copyText = async (value: string, successMessage: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const input = document.createElement('textarea');
        input.value = value;
        input.setAttribute('readonly', '');
        input.style.position = 'absolute';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }
      setFeedback(successMessage);
    } catch (error) {
      setFeedback(`Copy failed: ${String(error)}`);
    }
  };

  const openSlack = () => {
    window.open('slack://open', '_blank', 'noopener,noreferrer');
  };

  const submitMiniOg = () => {
    if (!canRunMiniOg) {
      return;
    }
    void onSubmit();
  };

  return (
    <div className={isMinimal ? 'slack-launchpad minimal' : 'slack-launchpad'}>
      <h2 className="launchpad-title">What should we ship?</h2>
      <div className="slack-composer-card">
        <label className="composer-field slack-composer-field">
          <textarea
            ref={textareaRef}
            value={draft}
            aria-label="Task prompt"
            onChange={event => onDraftChange(event.target.value)}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && isMiniOg) {
                event.preventDefault();
                submitMiniOg();
              }
            }}
            placeholder="Describe the review, bug, handoff, or next action you want ready for Slack."
            rows={4}
          />
        </label>

        <div className="slack-composer-toolbar">
          <div className="slack-target-segment" role="group" aria-label="Slack command target">
            {SLACK_TARGETS.map(item => (
              <button
                key={item.value}
                className={item.value === target ? 'slack-segment-button active' : 'slack-segment-button'}
                aria-pressed={item.value === target}
                type="button"
                onClick={() => onTargetChange(item.value)}
              >
                <span className="slack-segment-label">{item.label}</span>
                <span className="slack-segment-command">{item.command}</span>
              </button>
            ))}
          </div>

          <div className="slack-toolbar-actions">
            <button className="ghost-button slack-toolbar-button" type="button" onClick={openSlack}>
              Open Slack
            </button>
            <button className="ghost-button slack-toolbar-button" type="button" onClick={() => onDraftChange('')}>
              Clear
            </button>
          </div>
        </div>

        <div className="slack-command-bar">
          <div className="slack-preview">
            <span>Command preview</span>
            <code>{commandPreview}</code>
          </div>

          <div className="slack-launchpad-actions">
            {isMiniOg ? (
              <button
                className="primary-button"
                type="button"
                onClick={submitMiniOg}
                disabled={!canRunMiniOg}
              >
                {submitting ? 'Queueing...' : 'Run miniOG'}
              </button>
            ) : null}
            <button
              className={isMiniOg ? 'ghost-button' : 'primary-button'}
              type="button"
              onClick={() => copyText(commandPreview, `${selectedTarget.command} copied`)}
            >
              Copy command
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => copyText(draft.trim(), 'Prompt copied')}
              disabled={!draft.trim()}
            >
              Copy prompt
            </button>
          </div>
        </div>
      </div>

      <div className="slack-presets">
        {PROMPT_PRESETS.map(preset => (
          <button
            key={preset.label}
            className="slack-preset"
            type="button"
            onClick={() => onDraftChange(preset.prompt)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="slack-launchpad-footer">
        <span>{selectedTarget.description}</span>
        {feedback ? (
          <strong>{feedback}</strong>
        ) : isMiniOg ? (
          <span>
            {settingsRequired
              ? 'Finish Settings before running miniOG from Launchpad.'
              : 'Completion lands in the bot DM and as an in-app/macOS notification. Use Cmd/Ctrl+Enter to queue it.'}
          </span>
        ) : (
          <span>/wt stays compose-only in this version. Copy the command, then run it in Slack.</span>
        )}
      </div>
    </div>
  );
}
