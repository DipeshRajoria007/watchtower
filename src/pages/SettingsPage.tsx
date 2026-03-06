import type { FormEvent } from 'react';
import type { AppSettings } from '../types';
import {
  EmptyState,
  MetricCard,
  PageIntro,
  SectionCard,
  StatusBadge,
} from '../components/primitives';

type SettingsPageProps = {
  onSettingsChange: (settings: AppSettings) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  savingSettings: boolean;
  settings: AppSettings | null;
  settingsConfigured: boolean;
  settingsMessage: string | null;
};

type SectionSummary = {
  complete: number;
  items: number;
  label: string;
  ready: boolean;
};

export function SettingsPage({
  onSettingsChange,
  onSubmit,
  savingSettings,
  settings,
  settingsConfigured,
  settingsMessage,
}: SettingsPageProps) {
  if (!settings) {
    return (
      <div className="page-stack">
        <PageIntro
          eyebrow="Runtime Configuration"
          title="Settings"
          description="Slack authentication, ownership, repo path, and runtime limits all live here now."
        />
        <SectionCard title="Loading Settings" subtitle="Pulling runtime configuration from the local database.">
          <EmptyState>Loading settings.</EmptyState>
        </SectionCard>
      </div>
    );
  }

  const isAbsolutePath = (value: string) => value.trim().startsWith('/');
  const hasCommaList = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean).length > 0;

  const sections: SectionSummary[] = [
    {
      label: 'Slack Auth',
      complete: [settings.slackBotToken, settings.slackAppToken, settings.botUserId].filter(value => value.trim()).length,
      items: 3,
      ready: Boolean(settings.slackBotToken.trim() && settings.slackAppToken.trim() && settings.botUserId.trim()),
    },
    {
      label: 'Ownership / Channels',
      complete: [hasCommaList(settings.ownerSlackUserIds), hasCommaList(settings.bugsAndUpdatesChannelId)].filter(Boolean).length,
      items: 2,
      ready: hasCommaList(settings.ownerSlackUserIds) && hasCommaList(settings.bugsAndUpdatesChannelId),
    },
    {
      label: 'Repo Paths',
      complete: [isAbsolutePath(settings.newtonWebPath), isAbsolutePath(settings.newtonApiPath)].filter(Boolean).length,
      items: 2,
      ready: isAbsolutePath(settings.newtonWebPath) && isAbsolutePath(settings.newtonApiPath),
    },
    {
      label: 'Runtime Limits',
      complete: [
        settings.maxConcurrentJobs >= 1 && settings.maxConcurrentJobs <= 10,
        settings.prReviewTimeoutMs > 0,
        settings.bugFixTimeoutMs > 0,
        settings.repoClassifierThreshold >= 0 && settings.repoClassifierThreshold <= 1,
      ].filter(Boolean).length,
      items: 4,
      ready:
        settings.maxConcurrentJobs >= 1 &&
        settings.maxConcurrentJobs <= 10 &&
        settings.prReviewTimeoutMs > 0 &&
        settings.bugFixTimeoutMs > 0 &&
        settings.repoClassifierThreshold >= 0 &&
        settings.repoClassifierThreshold <= 1,
    },
  ];

  const completeSections = sections.filter(section => section.ready).length;

  return (
    <div className="page-stack settings-page">
      <PageIntro
        eyebrow="Runtime Configuration"
        title="Settings"
        description="The dedicated configuration page for Slack auth, ownership and channels, allowed repo paths, and execution limits. This is now the only place to edit runtime config."
        actions={
          <StatusBadge
            label={settingsConfigured ? 'Runtime Ready' : 'Action Needed'}
            tone={settingsConfigured ? 'success' : 'warn'}
          />
        }
      />

      <form className="settings-form-page" onSubmit={onSubmit}>
        <SectionCard
          title="Completeness Summary"
          subtitle="Page-level status mirrors the existing backend contract. Saving still validates repo directories against disk."
          count={`${completeSections}/${sections.length}`}
        >
          <div className="settings-summary-grid">
            <MetricCard label="Sections Ready" value={`${completeSections}/${sections.length}`} tone={settingsConfigured ? 'success' : 'warning'} />
            <MetricCard label="Runtime Status" value={settingsConfigured ? 'Ready' : 'Incomplete'} tone={settingsConfigured ? 'success' : 'danger'} />
            <MetricCard label="Save Validation" value="Enabled" tone="accent" />
            {sections.map(section => (
              <article className="settings-summary-card" key={section.label}>
                <div className="settings-summary-top">
                  <strong>{section.label}</strong>
                  <StatusBadge label={section.ready ? 'Ready' : 'Pending'} tone={section.ready ? 'success' : 'warn'} />
                </div>
                <p>
                  {section.complete}/{section.items} checks complete
                </p>
              </article>
            ))}
          </div>
        </SectionCard>

        <div className="settings-sections">
          <SectionCard title="Slack Auth" subtitle="Tokens and bot identity used to establish the Slack socket connection.">
            <div className="settings-fields two-column">
              <label className="field">
                <span>Slack Bot Token</span>
                <input
                  type="password"
                  value={settings.slackBotToken}
                  onChange={event => onSettingsChange({ ...settings, slackBotToken: event.target.value })}
                  placeholder="xoxb-..."
                />
              </label>

              <label className="field">
                <span>Slack App Token</span>
                <input
                  type="password"
                  value={settings.slackAppToken}
                  onChange={event => onSettingsChange({ ...settings, slackAppToken: event.target.value })}
                  placeholder="xapp-..."
                />
              </label>

              <label className="field">
                <span>Bot Slack User ID</span>
                <input
                  type="text"
                  value={settings.botUserId}
                  onChange={event => onSettingsChange({ ...settings, botUserId: event.target.value })}
                  placeholder="U0BOTUSER"
                />
              </label>
            </div>
          </SectionCard>

          <SectionCard title="Ownership / Channels" subtitle="Who owns Watchtower and where bug-fix workflows are allowed to auto-run.">
            <div className="settings-fields two-column">
              <label className="field">
                <span>Owner Slack User IDs</span>
                <input
                  type="text"
                  value={settings.ownerSlackUserIds}
                  onChange={event => onSettingsChange({ ...settings, ownerSlackUserIds: event.target.value })}
                  placeholder="U01234567,U07654321"
                />
              </label>

              <label className="field">
                <span>Bug-fix Channel IDs</span>
                <input
                  type="text"
                  value={settings.bugsAndUpdatesChannelId}
                  onChange={event => onSettingsChange({ ...settings, bugsAndUpdatesChannelId: event.target.value })}
                  placeholder="C01H25RNLJH,C02XXXXXXX"
                />
                <small className="field-hint">
                  Mentions are processed anywhere the bot is present. This list only governs bug-fix auto-runs.
                </small>
              </label>
            </div>
          </SectionCard>

          <SectionCard title="Repo Paths" subtitle="Absolute local directories that Watchtower is allowed to operate against.">
            <div className="settings-fields two-column">
              <label className="field">
                <span>newton-web Path</span>
                <input
                  type="text"
                  value={settings.newtonWebPath}
                  onChange={event => onSettingsChange({ ...settings, newtonWebPath: event.target.value })}
                  placeholder="/Users/you/code/newton-web"
                />
              </label>

              <label className="field">
                <span>newton-api Path</span>
                <input
                  type="text"
                  value={settings.newtonApiPath}
                  onChange={event => onSettingsChange({ ...settings, newtonApiPath: event.target.value })}
                  placeholder="/Users/you/code/newton-api"
                />
                <small className="field-hint">Save-time validation requires absolute paths that already exist on disk.</small>
              </label>
            </div>
          </SectionCard>

          <SectionCard title="Runtime Limits / Timeouts" subtitle="Concurrency, execution windows, and repo classification sensitivity.">
            <div className="settings-fields two-column">
              <label className="field">
                <span>Max Concurrent Jobs</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={settings.maxConcurrentJobs}
                  onChange={event =>
                    onSettingsChange({
                      ...settings,
                      maxConcurrentJobs: Number(event.target.value) || 1,
                    })
                  }
                />
              </label>

              <label className="field">
                <span>PR Review Timeout (ms)</span>
                <input
                  type="number"
                  min={1}
                  value={settings.prReviewTimeoutMs}
                  onChange={event =>
                    onSettingsChange({
                      ...settings,
                      prReviewTimeoutMs: Number(event.target.value) || 1,
                    })
                  }
                />
              </label>

              <label className="field">
                <span>Bug Fix Timeout (ms)</span>
                <input
                  type="number"
                  min={1}
                  value={settings.bugFixTimeoutMs}
                  onChange={event =>
                    onSettingsChange({
                      ...settings,
                      bugFixTimeoutMs: Number(event.target.value) || 1,
                    })
                  }
                />
              </label>

              <label className="field">
                <span>Repo Classifier Threshold</span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.repoClassifierThreshold}
                  onChange={event =>
                    onSettingsChange({
                      ...settings,
                      repoClassifierThreshold: Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
          </SectionCard>
        </div>

        <div className="settings-sticky-bar">
          <div className="settings-sticky-copy">
            <strong>{settingsConfigured ? 'Runtime configuration is complete.' : 'Finish the required settings before the sidecar can boot.'}</strong>
            {settingsMessage ? (
              <p className={settingsMessage.startsWith('Failed') ? 'error' : 'success'}>{settingsMessage}</p>
            ) : (
              <p className="muted">Saving uses the existing Tauri command and does not change backend schema or contracts.</p>
            )}
          </div>

          <button className="primary-button" type="submit" disabled={savingSettings}>
            {savingSettings ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
