import { useEffect, useState } from 'react';
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
  activeJobs: RunSummary[];
  recentRuns: RunSummary[];
  failures: RunSummary[];
};

const POLL_MS = 5000;

function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const result = await invoke<DashboardData>('get_dashboard_data');
        if (active) {
          setData(result);
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
      void load();
    }, POLL_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

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
      </header>

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
