import { SlackLaunchpad } from '../components/SlackLaunchpad';
import type { SlackCommandTarget } from '../types';

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
      <p className="launchpad-copy">
        Draft a Slack task, choose the handler to execute it.
      </p>

      <section className="surface-card launchpad-shell">
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
