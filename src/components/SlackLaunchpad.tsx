import { useEffect, useMemo, useRef, useState } from 'react';
import { StatusBadge } from './primitives';
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
  'Review this PR and summarize blockers before I request human review.',
  'Diagnose the latest failed run and tell me the fastest next step.',
  'Draft an implementation plan for this feature with risks and sequencing.',
  'Summarize channel heat and tell me where I should intervene first.',
];

type SlackLaunchpadProps = {
  draft: string;
  focusToken: number;
  onDraftChange: (value: string) => void;
  onTargetChange: (value: SlackCommandTarget) => void;
  target: SlackCommandTarget;
};

export function SlackLaunchpad({
  draft,
  focusToken,
  onDraftChange,
  onTargetChange,
  target,
}: SlackLaunchpadProps) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedTarget = useMemo(() => {
    return SLACK_TARGETS.find(item => item.value === target) ?? SLACK_TARGETS[0];
  }, [target]);

  const commandPreview = draft.trim()
    ? `${selectedTarget.command} ${draft.trim()}`
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

  return (
    <div className="slack-launchpad">
      <div className="slack-launchpad-top">
        <div className="slack-targets" role="tablist" aria-label="Slack command target">
          {SLACK_TARGETS.map(item => (
            <button
              key={item.value}
              className={item.value === target ? 'slack-target active' : 'slack-target'}
              type="button"
              onClick={() => onTargetChange(item.value)}
            >
              <span className="slack-target-label">{item.label}</span>
              <span className="slack-target-command">{item.command}</span>
              <span className="slack-target-description">{item.description}</span>
            </button>
          ))}
        </div>

        <div className="slack-shortcut-note">
          <StatusBadge label="Cmd+M" tone="info" />
          <span>Selects miniOG and focuses the prompt.</span>
        </div>
      </div>

      <label className="composer-field">
        <span>Task Prompt</span>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={event => onDraftChange(event.target.value)}
          placeholder="Ask for a PR review, a debugging pass, a spec draft, or a Slack-thread response."
          rows={5}
        />
      </label>

      <div className="slack-presets">
        {PROMPT_PRESETS.map(preset => (
          <button
            key={preset}
            className="slack-preset"
            type="button"
            onClick={() => onDraftChange(preset)}
          >
            {preset}
          </button>
        ))}
      </div>

      <div className="slack-launchpad-bottom">
        <div className="slack-preview">
          <span>Slack Command Preview</span>
          <code>{commandPreview}</code>
        </div>

        <div className="slack-launchpad-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => copyText(commandPreview, `${selectedTarget.command} copied`)}
          >
            Copy Slack Command
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => copyText(draft.trim(), 'Prompt copied')}
            disabled={!draft.trim()}
          >
            Copy Prompt Only
          </button>
          <button className="ghost-button" type="button" onClick={openSlack}>
            Open Slack
          </button>
          <button className="ghost-button" type="button" onClick={() => onDraftChange('')}>
            Clear
          </button>
        </div>
      </div>

      <div className="slack-launchpad-footer">
        <span>{selectedTarget.label} uses {selectedTarget.command} in Slack.</span>
        {feedback ? <strong>{feedback}</strong> : <span>Drafts stay in the app while you move between pages.</span>}
      </div>
    </div>
  );
}
