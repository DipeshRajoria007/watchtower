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
  return (
    <div className="launchpad-page">
      <div className="launchpad-intro">
        <h1 className="launchpad-title">Where should we start?</h1>

        <p className="launchpad-copy">
          Draft a task once, route it to the right assistant, and keep the exact
          Slack command ready to send.
        </p>
      </div>

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
