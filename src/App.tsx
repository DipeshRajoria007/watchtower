import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type RunSummary = {
  id: string;
  workflow: string;
  status: string;
  channelId: string;
  threadTs: string;
  createdAt: string;
  updatedAt: string;
  errorMessage: string | null;
};

type DashboardData = {
  sidecarStatus: string;
  settingsConfigured: boolean;
  activeJobs: RunSummary[];
  recentRuns: RunSummary[];
  failures: RunSummary[];
};

type AppSettings = {
  slackBotToken: string;
  slackAppToken: string;
  ownerSlackUserIds: string;
  botUserId: string;
  bugsAndUpdatesChannelId: string;
  newtonWebPath: string;
  newtonApiPath: string;
  maxConcurrentJobs: number;
  prReviewTimeoutMs: number;
  bugFixTimeoutMs: number;
  repoClassifierThreshold: number;
};

type SaveSettingsResponse = {
  configured: boolean;
};

const POLL_MS = 5000;

function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const settingsIncomplete = useMemo(() => {
    return data ? !data.settingsConfigured : false;
  }, [data]);

  const summary = useMemo(() => {
    return {
      active: data?.activeJobs.length ?? 0,
      recent: data?.recentRuns.length ?? 0,
      failures: data?.failures.length ?? 0,
    };
  }, [data]);

  const loadDashboard = async () => {
    const result = await invoke<DashboardData>('get_dashboard_data');
    setData(result);
  };

  const loadSettings = async () => {
    const result = await invoke<AppSettings>('get_app_settings');
    setSettings(result);
  };

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const [dashboard, appSettings] = await Promise.all([
          invoke<DashboardData>('get_dashboard_data'),
          invoke<AppSettings>('get_app_settings'),
        ]);
        if (active) {
          setData(dashboard);
          setSettings(appSettings);
          setError(null);
        }
      } catch (err) {
        if (active) {
          setError(String(err));
        }
      }
    };

    void load();
    const interval = window.setInterval(() => {
      void loadDashboard().catch(err => {
        if (active) {
          setError(String(err));
        }
      });
    }, POLL_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsSettingsOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const saveSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settings) {
      return;
    }

    setSavingSettings(true);
    setSettingsMessage(null);

    try {
      const result = await invoke<SaveSettingsResponse>('save_app_settings', { settings });
      await loadDashboard();
      await loadSettings();

      setSettingsMessage(
        result.configured
          ? 'Settings saved. Runtime config is complete and sidecar should boot automatically.'
          : 'Saved, but config is still incomplete. Fill all required fields.'
      );
    } catch (err) {
      setSettingsMessage(`Failed to save settings: ${String(err)}`);
    } finally {
      setSavingSettings(false);
    }
  };

  if (error) {
    return (
      <main className="app-shell">
        <section className="panel error-panel">
          <h1>Watchtower</h1>
          <p className="error">{error}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="glow glow-1" />
      <div className="glow glow-2" />

      <header className="topbar">
        <div>
          <p className="eyebrow">Developer Automation Console</p>
          <h1>Watchtower</h1>
          <p className="status-line">Sidecar: {data?.sidecarStatus ?? 'starting'}</p>
        </div>

        <div className="top-actions">
          <button
            className="icon-btn"
            type="button"
            aria-label="Open settings"
            onClick={() => setIsSettingsOpen(true)}
          >
            <GearIcon />
          </button>
        </div>
      </header>

      {settingsIncomplete ? (
        <section className="warning-strip">
          <div>
            <strong>Configuration required.</strong> Settings are incomplete, so the sidecar will stay paused.
          </div>
          <button type="button" onClick={() => setIsSettingsOpen(true)}>
            Open Settings
          </button>
        </section>
      ) : null}

      <section className="stats-grid">
        <StatCard label="Active Jobs" value={summary.active} tone="active" />
        <StatCard label="Recent Runs" value={summary.recent} tone="recent" />
        <StatCard label="Failures" value={summary.failures} tone="failures" />
      </section>

      <section className="panel">
        <PanelHeader title="Active Jobs" subtitle="In-flight workflow executions" count={summary.active} />
        <RunList runs={data?.activeJobs ?? []} empty="No active jobs. Idle and watching Slack." />
      </section>

      <section className="panel-grid">
        <section className="panel">
          <PanelHeader title="Last 50 Runs" subtitle="Most recent execution history" count={summary.recent} />
          <RunList runs={data?.recentRuns ?? []} empty="No run history yet." />
        </section>

        <section className="panel">
          <PanelHeader title="Failures" subtitle="Items requiring manual attention" count={summary.failures} />
          <RunList runs={data?.failures ?? []} empty="No failures. System stable." />
        </section>
      </section>

      <div className={isSettingsOpen ? 'settings-overlay open' : 'settings-overlay'} onClick={() => setIsSettingsOpen(false)} />

      <aside className={isSettingsOpen ? 'settings-drawer open' : 'settings-drawer'}>
        <div className="drawer-head">
          <div>
            <p className="eyebrow">Runtime Configuration</p>
            <h2>Settings</h2>
          </div>
          <button className="icon-btn" type="button" aria-label="Close settings" onClick={() => setIsSettingsOpen(false)}>
            <CloseIcon />
          </button>
        </div>

        {!settings ? (
          <p className="muted">Loading settings...</p>
        ) : (
          <form className="settings-form" onSubmit={saveSettings}>
            <div className="field-group">
              <label className="field">
                <span>Slack Bot Token</span>
                <input
                  type="password"
                  value={settings.slackBotToken}
                  onChange={event => setSettings({ ...settings, slackBotToken: event.target.value })}
                  placeholder="xoxb-..."
                />
              </label>

              <label className="field">
                <span>Slack App Token (Socket Mode)</span>
                <input
                  type="password"
                  value={settings.slackAppToken}
                  onChange={event => setSettings({ ...settings, slackAppToken: event.target.value })}
                  placeholder="xapp-..."
                />
              </label>
            </div>

            <div className="field-group">
              <label className="field">
                <span>Owner Slack User IDs (comma separated)</span>
                <input
                  type="text"
                  value={settings.ownerSlackUserIds}
                  onChange={event => setSettings({ ...settings, ownerSlackUserIds: event.target.value })}
                  placeholder="U01234567,U07654321"
                />
              </label>

              <label className="field">
                <span>Bot Slack User ID</span>
                <input
                  type="text"
                  value={settings.botUserId}
                  onChange={event => setSettings({ ...settings, botUserId: event.target.value })}
                  placeholder="U0BOTUSER"
                />
              </label>
            </div>

            <div className="field-group">
              <label className="field">
                <span>Bugs & Updates Channel ID</span>
                <input
                  type="text"
                  value={settings.bugsAndUpdatesChannelId}
                  onChange={event => setSettings({ ...settings, bugsAndUpdatesChannelId: event.target.value })}
                  placeholder="C01H25RNLJH"
                />
              </label>

              <label className="field">
                <span>Max Concurrent Jobs</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={settings.maxConcurrentJobs}
                  onChange={event =>
                    setSettings({
                      ...settings,
                      maxConcurrentJobs: Number(event.target.value) || 1,
                    })
                  }
                />
              </label>
            </div>

            <div className="field-group">
              <label className="field">
                <span>newton-web Path</span>
                <input
                  type="text"
                  value={settings.newtonWebPath}
                  onChange={event => setSettings({ ...settings, newtonWebPath: event.target.value })}
                  placeholder="/Users/you/code/newton-web"
                />
              </label>

              <label className="field">
                <span>newton-api Path</span>
                <input
                  type="text"
                  value={settings.newtonApiPath}
                  onChange={event => setSettings({ ...settings, newtonApiPath: event.target.value })}
                  placeholder="/Users/you/code/newton-api"
                />
              </label>
            </div>

            <div className="field-group">
              <label className="field">
                <span>PR Review Timeout (ms)</span>
                <input
                  type="number"
                  min={1}
                  value={settings.prReviewTimeoutMs}
                  onChange={event =>
                    setSettings({
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
                    setSettings({
                      ...settings,
                      bugFixTimeoutMs: Number(event.target.value) || 1,
                    })
                  }
                />
              </label>
            </div>

            <label className="field">
              <span>Repo Classifier Threshold</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={settings.repoClassifierThreshold}
                onChange={event =>
                  setSettings({
                    ...settings,
                    repoClassifierThreshold: Number(event.target.value),
                  })
                }
              />
            </label>

            <div className="actions">
              <button type="submit" disabled={savingSettings}>
                {savingSettings ? 'Saving...' : 'Save Settings'}
              </button>
            </div>

            {settingsMessage ? (
              <p className={settingsMessage.startsWith('Failed') ? 'error' : 'success'}>{settingsMessage}</p>
            ) : null}
          </form>
        )}
      </aside>
    </main>
  );
}

function PanelHeader({ title, subtitle, count }: { title: string; subtitle: string; count: number }) {
  return (
    <div className="panel-head">
      <div>
        <h2>{title}</h2>
        <p className="muted">{subtitle}</p>
      </div>
      <span className="chip">{count}</span>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: 'active' | 'recent' | 'failures' }) {
  return (
    <article className={`stat-card ${tone}`}>
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

function RunList({ runs, empty }: { runs: RunSummary[]; empty: string }) {
  if (runs.length === 0) {
    return <p className="empty-state">{empty}</p>;
  }

  return (
    <ul className="run-list">
      {runs.map(run => (
        <li key={run.id}>
          <div className="run-top">
            <span className="run-workflow">{run.workflow}</span>
            <span className={`badge ${run.status.toLowerCase()}`}>{run.status}</span>
          </div>
          <div className="run-meta">channel={run.channelId}</div>
          <div className="run-meta">thread={run.threadTs}</div>
          <div className="run-meta">updated={run.updatedAt}</div>
          {run.errorMessage ? <div className="error">{run.errorMessage}</div> : null}
        </li>
      ))}
    </ul>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15.3a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m18 6-12 12" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export default App;
