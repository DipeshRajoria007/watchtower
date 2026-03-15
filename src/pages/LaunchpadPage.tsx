import { SlackLaunchpad } from "../components/SlackLaunchpad";
import type { SlackCommandTarget } from "../types";

type LaunchpadPageProps = {
  draft: string;
  focusToken: number;
  onDraftChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  onTargetChange: (value: SlackCommandTarget) => void;
  settingsRequired: boolean;
  submitting: boolean;
  target: SlackCommandTarget;
};

export function LaunchpadPage({
  draft,
  focusToken,
  onDraftChange,
  onSubmit,
  onTargetChange,
  settingsRequired,
  submitting,
  target,
}: LaunchpadPageProps) {
  return (
    <div className="launchpad-page">
      <section className="launchpad-shell">
        <SlackLaunchpad
          draft={draft}
          focusToken={focusToken}
          onDraftChange={onDraftChange}
          onSubmit={onSubmit}
          onTargetChange={onTargetChange}
          settingsRequired={settingsRequired}
          submitting={submitting}
          target={target}
          variant="minimal"
        />
      </section>
    </div>
  );
}
