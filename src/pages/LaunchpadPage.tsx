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
        Draft the task here, choose who should handle it in Slack, and copy the exact command. This page stays deliberately minimal.
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
