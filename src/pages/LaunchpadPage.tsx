import { SlackLaunchpad } from "../components/SlackLaunchpad";
import type { SlackCommandTarget } from "../types";

type LaunchpadPageProps = {
  draft: string;
  focusToken: number;
  onDraftChange: (value: string) => void;
  onTargetChange: (value: SlackCommandTarget) => void;
  target: SlackCommandTarget;
};

export function LaunchpadPage({
  draft,
  focusToken,
  onDraftChange,
  onTargetChange,
  target,
}: LaunchpadPageProps) {
  const targetSummary =
    target === 'watchtower'
      ? {
          label: 'Operational route',
          value: '/wt',
          detail: 'Status checks, traces, failures, diagnostics, and learning heat.',
        }
      : {
          label: 'Builder route',
          value: '/miniog',
          detail: 'Free-form execution, drafting, research, and implementation handoffs.',
        };

  return (
    <div className="launchpad-page">
      <section className="launchpad-hero">
        <div className="launchpad-intro">
          <p className="eyebrow">Slack Command Deck</p>
          <h1 className="launchpad-title">Draft once. Route cleanly. Keep the exact command ready.</h1>

          <p className="launchpad-copy">
            Shape the task in one quiet surface, switch between assistants without rewriting it, and copy the final Slack command when it is ready to send.
          </p>
        </div>

        <div className="launchpad-hero-grid">
          <article className="launchpad-hero-card">
            <span>{targetSummary.label}</span>
            <strong>{targetSummary.value}</strong>
            <p>{targetSummary.detail}</p>
          </article>

          <article className="launchpad-hero-card">
            <span>Prompt presets</span>
            <strong>5 ready-made starts</strong>
            <p>Review, diagnose, plan, summarize channel heat, or draft a concise reply without starting from a blank slate.</p>
          </article>

          <article className="launchpad-hero-card">
            <span>Fast recall</span>
            <strong>Cmd/Ctrl + M</strong>
            <p>The composer stays one shortcut away, so you can reopen it quickly while moving through runs, intelligence, and settings.</p>
          </article>
        </div>
      </section>

      <section className="launchpad-shell">
        <SlackLaunchpad
          draft={draft}
          focusToken={focusToken}
          onDraftChange={onDraftChange}
          onTargetChange={onTargetChange}
          target={target}
          variant="minimal"
        />
      </section>
    </div>
  );
}
