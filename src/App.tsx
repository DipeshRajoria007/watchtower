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
  const [tab, setTab] = useState<'dashboard' | 'settings'>('dashboard');
  const [data, setData] = useState<DashboardData | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const settingsIncomplete = useMemo(() => {
    return data ? !data.settingsConfigured : false;
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
          ? 'Settings saved. Sidecar is configured and will run automatically.'
          : 'Settings saved. Fill all required fields to start sidecar workflows.'
      );
    } catch (err) {
      setSettingsMessage(`Failed to save settings: ${String(err)}`);
    } finally {
      setSavingSettings(false);
    }
  };

  if (error) {
    return (
      <main className="container">
        <h1>Watchtower</h1>
        <p className="error">{error}</p>
      </main>
    );
  }

  return (
    <main className="container">
      <header>
        <h1>Watchtower</h1>
        <p>macOS-only Slack mention automation</p>
        <p className="status">Sidecar: {data?.sidecarStatus ?? 'starting'}</p>
        {settingsIncomplete ? (
          <p className="warning">Settings incomplete. Open Settings and save required fields.</p>
        ) : null}
      </header>

      <div className="tabs">
        <button type="button" className={tab === 'dashboard' ? 'tab active' : 'tab'} onClick={() => setTab('dashboard')}>
          Dashboard
        </button>
        <button type="button" className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => setTab('settings')}>
          Settings
        </button>
      </div>

      {tab === 'dashboard' ? (
        <>
          <section>
            <h2>Active Jobs</h2>
            <RunList runs={data?.activeJobs ?? []} empty="No active jobs" />
          </section>

          <section>
            <h2>Last 50 Runs</h2>
            <RunList runs={data?.recentRuns ?? []} empty="No runs yet" />
          </section>

          <section>
            <h2>Failures Requiring Attention</h2>
            <RunList runs={data?.failures ?? []} empty="No failures" />
          </section>
        </>
      ) : (
        <section>
          <h2>App Settings</h2>
          <p className="muted">All runtime config is managed here and stored locally in app database.</p>

          {!settings ? (
            <p className="muted">Loading settings...</p>
          ) : (
            <form className="settings-form" onSubmit={saveSettings}>
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
        </section>
      )}
    </main>
  );
}

function RunList({ runs, empty }: { runs: RunSummary[]; empty: string }) {
  if (runs.length === 0) {
    return <p className="muted">{empty}</p>;
  }

  return (
    <ul className="run-list">
      {runs.map(run => (
        <li key={run.id}>
          <div>
            <strong>{run.workflow}</strong> <span className={`badge ${run.status.toLowerCase()}`}>{run.status}</span>
          </div>
          <div className="muted">
            channel={run.channelId} thread={run.threadTs}
          </div>
          <div className="muted">updated={run.updatedAt}</div>
          {run.errorMessage ? <div className="error">{run.errorMessage}</div> : null}
        </li>
      ))}
    </ul>
  );
}

export default App;
