import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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

type JobLogEntry = {
  id: number;
  jobId: string;
  level: 'INFO' | 'WARN' | 'ERROR' | string;
  stage: string;
  message: string;
  dataJson: string | null;
  createdAt: string;
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
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunLogs, setSelectedRunLogs] = useState<JobLogEntry[]>([]);
  const [liveSidecarLogs, setLiveSidecarLogs] = useState<string[]>([]);
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

  const allRuns = useMemo(() => {
    if (!data) {
      return [] as RunSummary[];
    }

    const map = new Map<string, RunSummary>();
    for (const run of [...data.activeJobs, ...data.recentRuns, ...data.failures]) {
      map.set(run.id, run);
    }
    return Array.from(map.values());
  }, [data]);

  const selectedRun = useMemo(() => {
    if (!selectedRunId) {
      return null;
    }
    return allRuns.find(run => run.id === selectedRunId) ?? null;
  }, [allRuns, selectedRunId]);

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

  useEffect(() => {
    if (!data) {
      return;
    }
    const runExists = selectedRunId ? allRuns.some(run => run.id === selectedRunId) : false;
    if (runExists) {
      return;
    }
    const preferred = data.activeJobs[0]?.id ?? data.recentRuns[0]?.id ?? data.failures[0]?.id ?? null;
    setSelectedRunId(preferred);
  }, [allRuns, data, selectedRunId]);

  useEffect(() => {
    let active = true;

    const refreshLogs = async () => {
      if (!selectedRunId) {
        if (active) {
          setSelectedRunLogs([]);
        }
        return;
      }

      try {
        const logs = await invoke<JobLogEntry[]>('get_job_logs', { jobId: selectedRunId, limit: 1000 });
        if (active) {
          setSelectedRunLogs(logs);
        }
      } catch (err) {
        if (active) {
          setError(String(err));
        }
      }
    };

    void refreshLogs();
    const interval = window.setInterval(() => {
      void refreshLogs();
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [selectedRunId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<string>('sidecar-log', event => {
      const line = formatSidecarLine(event.payload);
      setLiveSidecarLogs(previous => {
        const next = [...previous, line];
        if (next.length > 400) {
          return next.slice(next.length - 400);
        }
        return next;
      });
    }).then(handler => {
      if (disposed) {
        handler();
      } else {
        unlisten = handler;
      }
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
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
          <RunList
            runs={data?.activeJobs ?? []}
            empty="No active jobs. Idle and watching Slack."
            selectedRunId={selectedRunId}
            onSelect={runId => setSelectedRunId(runId)}
          />
      </section>

      <section className="panel-grid">
        <section className="panel">
          <PanelHeader title="Last 50 Runs" subtitle="Most recent execution history" count={summary.recent} />
          <RunList
            runs={data?.recentRuns ?? []}
            empty="No run history yet."
            selectedRunId={selectedRunId}
            onSelect={runId => setSelectedRunId(runId)}
          />
        </section>

        <section className="panel">
          <PanelHeader title="Failures" subtitle="Items requiring manual attention" count={summary.failures} />
          <RunList
            runs={data?.failures ?? []}
            empty="No failures. System stable."
            selectedRunId={selectedRunId}
            onSelect={runId => setSelectedRunId(runId)}
          />
        </section>
      </section>

      <section className="panel-grid">
        <section className="panel">
          <PanelHeader
            title="Execution Trace"
            subtitle={selectedRun ? `job=${selectedRun.id}` : 'Select a run to inspect every step'}
            count={selectedRunLogs.length}
          />
          <TraceList logs={selectedRunLogs} selectedRun={selectedRun} />
        </section>

        <section className="panel">
          <PanelHeader
            title="Live Sidecar Stream"
            subtitle="Raw sidecar output (stdout + stderr), newest at bottom"
            count={liveSidecarLogs.length}
          />
          <LiveLogConsole lines={liveSidecarLogs} />
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
                <span>Bug-fix Channel IDs (comma separated)</span>
                <input
                  type="text"
                  value={settings.bugsAndUpdatesChannelId}
                  onChange={event => setSettings({ ...settings, bugsAndUpdatesChannelId: event.target.value })}
                  placeholder="C01H25RNLJH,C02XXXXXXX"
                />
                <small className="field-hint">
                  Mentions are processed from all channels where the bot is present. This list only controls where
                  bug-fix workflow auto-runs.
                </small>
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

function RunList({
  runs,
  empty,
  selectedRunId,
  onSelect,
}: {
  runs: RunSummary[];
  empty: string;
  selectedRunId?: string | null;
  onSelect?: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return <p className="empty-state">{empty}</p>;
  }

  return (
    <ul className="run-list">
      {runs.map(run => (
        <li
          key={run.id}
          className={run.id === selectedRunId ? 'selected' : ''}
          role="button"
          tabIndex={0}
          onClick={() => onSelect?.(run.id)}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect?.(run.id);
            }
          }}
        >
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

function TraceList({ logs, selectedRun }: { logs: JobLogEntry[]; selectedRun: RunSummary | null }) {
  if (!selectedRun) {
    return <p className="empty-state">Pick any run above to inspect detailed step logs.</p>;
  }

  if (logs.length === 0) {
    return <p className="empty-state">No trace entries persisted yet for this run.</p>;
  }

  return (
    <ul className="trace-list">
      {logs.map(log => (
        <li key={log.id}>
          <div className="trace-top">
            <span className={`badge ${log.level.toLowerCase()}`}>{log.level}</span>
            <span className="trace-stage">{log.stage}</span>
            <span className="trace-time">{log.createdAt}</span>
          </div>
          <div className="trace-message">{log.message}</div>
          {log.dataJson ? <pre className="trace-data">{prettyJson(log.dataJson)}</pre> : null}
        </li>
      ))}
    </ul>
  );
}

function LiveLogConsole({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return <p className="empty-state">Waiting for sidecar log output...</p>;
  }

  return (
    <pre className="live-log-console">
      {lines.map((line, index) => (
        <div key={`${index}-${line.slice(0, 30)}`}>{line}</div>
      ))}
    </pre>
  );
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function formatSidecarLine(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const level = mapPinoLevel(parsed.level);
    const message = typeof parsed.msg === 'string' ? parsed.msg : raw;
    const time = typeof parsed.time === 'string' ? parsed.time : new Date().toISOString();
    const stage = typeof parsed.stage === 'string' ? parsed.stage : '';
    const jobId = typeof parsed.jobId === 'string' ? parsed.jobId : '';
    const workflow = typeof parsed.workflow === 'string' ? parsed.workflow : '';

    const parts = [`[${time}]`, `[${level}]`];
    if (workflow) parts.push(`[${workflow}]`);
    if (stage) parts.push(`[${stage}]`);
    if (jobId) parts.push(`[job=${jobId}]`);
    parts.push(message);
    return parts.join(' ');
  } catch {
    return raw;
  }
}

function mapPinoLevel(level: unknown): string {
  if (typeof level === 'number') {
    if (level >= 50) return 'ERROR';
    if (level >= 40) return 'WARN';
    if (level >= 30) return 'INFO';
    return 'DEBUG';
  }
  return 'INFO';
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
