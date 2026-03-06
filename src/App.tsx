import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AppShell } from './components/AppShell';
import { formatSidecarLine } from './lib/formatters';
import { IntelligencePage } from './pages/IntelligencePage';
import { LaunchpadPage } from './pages/LaunchpadPage';
import { OverviewPage } from './pages/OverviewPage';
import { RunsPage } from './pages/RunsPage';
import { SettingsPage } from './pages/SettingsPage';
import type {
  AppSettings,
  AppView,
  DashboardData,
  JobLogEntry,
  RunSummary,
  RunsSubView,
  SaveSettingsResponse,
  SlackCommandTarget,
} from './types';

const POLL_MS = 5000;
const PENDING_SHORTCUT_VIEW_KEY = 'watchtower:pending-shortcut-view';
const PENDING_SHORTCUT_TARGET_KEY = 'watchtower:pending-shortcut-target';

function toggleSlackCommandTarget(target: SlackCommandTarget): SlackCommandTarget {
  return target === 'miniog' ? 'watchtower' : 'miniog';
}

function readPendingShortcutView(): AppView | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const value = window.localStorage.getItem(PENDING_SHORTCUT_VIEW_KEY);
  return value === 'launchpad' ? 'launchpad' : null;
}

function readPendingShortcutTarget(): SlackCommandTarget | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const value = window.localStorage.getItem(PENDING_SHORTCUT_TARGET_KEY);
  return value === 'miniog' || value === 'watchtower' ? value : null;
}

function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [view, setView] = useState<AppView>('overview');
  const [runsSubView, setRunsSubView] = useState<RunsSubView>('active');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunLogs, setSelectedRunLogs] = useState<JobLogEntry[]>([]);
  const [liveSidecarLogs, setLiveSidecarLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const [slackComposerDraft, setSlackComposerDraft] = useState('');
  const [slackCommandTarget, setSlackCommandTarget] = useState<SlackCommandTarget>('miniog');
  const [slackComposerFocusToken, setSlackComposerFocusToken] = useState(0);

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
    setError(null);
  };

  const loadSettings = async () => {
    const result = await invoke<AppSettings>('get_app_settings');
    setSettings(result);
    setError(null);
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
    const pendingView = readPendingShortcutView();
    const pendingTarget = readPendingShortcutTarget();
    if (pendingView !== 'launchpad') {
      return;
    }

    setView('launchpad');
    if (pendingTarget) {
      setSlackCommandTarget(pendingTarget);
    }
    window.localStorage.removeItem(PENDING_SHORTCUT_VIEW_KEY);
    window.localStorage.removeItem(PENDING_SHORTCUT_TARGET_KEY);
  }, []);

  const openLaunchpad = (target: SlackCommandTarget = 'miniog') => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PENDING_SHORTCUT_VIEW_KEY, 'launchpad');
      window.localStorage.setItem(PENDING_SHORTCUT_TARGET_KEY, target);
    }

    setSlackCommandTarget(target);
    setView('launchpad');
    setNavDrawerOpen(false);
    setSlackComposerFocusToken(previous => previous + 1);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.code === 'KeyM') {
        event.preventDefault();
        event.stopPropagation();
        openLaunchpad(toggleSlackCommandTarget(slackCommandTarget));
        return;
      }

      if (event.key === 'Escape') {
        setNavDrawerOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [slackCommandTarget]);

  useEffect(() => {
    if (!data) {
      return;
    }

    const runExists = selectedRunId ? allRuns.some(run => run.id === selectedRunId) : false;
    if (runExists) {
      return;
    }

    const preferred = data.activeJobs[0]?.id ?? data.failures[0]?.id ?? data.recentRuns[0]?.id ?? null;
    setSelectedRunId(preferred);
  }, [allRuns, data, selectedRunId]);

  useEffect(() => {
    if (!data || runsSubView === 'diagnostics') {
      return;
    }

    const viewRuns =
      runsSubView === 'active'
        ? data.activeJobs
        : runsSubView === 'failures'
          ? data.failures
          : data.recentRuns;

    if (viewRuns.length === 0) {
      return;
    }

    const existsInView = selectedRunId ? viewRuns.some(run => run.id === selectedRunId) : false;
    if (!existsInView) {
      setSelectedRunId(viewRuns[0].id);
    }
  }, [data, runsSubView, selectedRunId]);

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
          setError(null);
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

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) {
      return;
    }

    setSavingSettings(true);
    setSettingsMessage(null);

    try {
      const result = await invoke<SaveSettingsResponse>('save_app_settings', { settings });
      await Promise.all([loadDashboard(), loadSettings()]);

      setSettingsMessage(
        result.configured
          ? 'Settings saved. Runtime config is complete and the sidecar should boot automatically.'
          : 'Saved, but config is still incomplete. Fill all required fields.'
      );
    } catch (err) {
      setSettingsMessage(`Failed to save settings: ${String(err)}`);
    } finally {
      setSavingSettings(false);
    }
  };

  const navigateToView = (nextView: AppView) => {
    setView(nextView);
    setNavDrawerOpen(false);
  };

  const openRunsWorkspace = (subView: RunsSubView) => {
    setRunsSubView(subView);
    setView('runs');
    setNavDrawerOpen(false);
  };

  if (error && !data && !settings) {
    return (
      <main className="error-view">
        <section className="surface-card">
          <p className="eyebrow">Startup Error</p>
          <h1>Watchtower</h1>
          <p className="error">{error}</p>
        </section>
      </main>
    );
  }

  return (
    <AppShell
      currentView={view}
      failuresCount={summary.failures}
      navDrawerOpen={navDrawerOpen}
      onNavigate={navigateToView}
      onToggleNavDrawer={() => setNavDrawerOpen(open => !open)}
      settingsRequired={settingsIncomplete}
      sidecarStatus={data?.sidecarStatus ?? 'starting'}
    >
      {error ? <div className="inline-error-banner">{error}</div> : null}

      {view === 'overview' ? (
        <OverviewPage
          data={data}
          onOpenIntelligence={() => navigateToView('intelligence')}
          onOpenRuns={openRunsWorkspace}
          onOpenSettings={() => navigateToView('settings')}
          onSelectRun={setSelectedRunId}
        />
      ) : null}

      {view === 'launchpad' ? (
        <LaunchpadPage
          draft={slackComposerDraft}
          focusToken={slackComposerFocusToken}
          onDraftChange={setSlackComposerDraft}
          onTargetChange={setSlackCommandTarget}
          target={slackCommandTarget}
        />
      ) : null}

      {view === 'runs' ? (
        <RunsPage
          data={data}
          liveSidecarLogs={liveSidecarLogs}
          onSelectRun={setSelectedRunId}
          onSubViewChange={setRunsSubView}
          runsSubView={runsSubView}
          selectedRun={selectedRun}
          selectedRunId={selectedRunId}
          selectedRunLogs={selectedRunLogs}
        />
      ) : null}

      {view === 'intelligence' ? <IntelligencePage data={data} /> : null}

      {view === 'settings' ? (
        <SettingsPage
          onSettingsChange={nextSettings => setSettings(nextSettings)}
          onSubmit={saveSettings}
          savingSettings={savingSettings}
          settings={settings}
          settingsConfigured={data?.settingsConfigured ?? false}
          settingsMessage={settingsMessage}
        />
      ) : null}
    </AppShell>
  );
}

export default App;
