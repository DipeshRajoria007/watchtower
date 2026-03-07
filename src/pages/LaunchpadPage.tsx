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
