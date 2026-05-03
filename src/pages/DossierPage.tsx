import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { GlowCard } from '../components/GlowCard';
import { PageIntro } from '../components/primitives';
import { Timestamp } from '../components/Timestamp';
import type { DossierDetail, DossierForgetField, DossierRole, DossierSummary } from '../types';

const ROLES: DossierRole[] = ['pm', 'dev', 'designer', 'ops'];
const FORGET_FIELDS: Array<{ value: DossierForgetField; label: string }> = [
  { value: 'role', label: 'Role' },
  { value: 'tone', label: 'Tone' },
  { value: 'notes', label: 'Notes' },
  { value: 'project_affinity', label: 'Project affinity' },
  { value: 'metrics', label: 'Metrics' },
  { value: 'all', label: 'Everything' },
];

export function DossierPage() {
  const [dossiers, setDossiers] = useState<DossierSummary[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DossierDetail | null>(null);
  const [search, setSearch] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState('');

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const rows = await invoke<DossierSummary[]>('list_dossiers');
      setDossiers(rows);
    } catch (err) {
      setError(`Failed to load dossiers: ${String(err)}`);
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadDetail = useCallback(async (userId: string) => {
    setLoadingDetail(true);
    setError(null);
    try {
      const result = await invoke<DossierDetail>('get_dossier', { userId });
      setDetail(result);
      setNotesDraft(result.notes ?? '');
    } catch (err) {
      setError(`Failed to load dossier: ${String(err)}`);
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedUserId) void loadDetail(selectedUserId);
    else {
      setDetail(null);
      setNotesDraft('');
    }
  }, [selectedUserId, loadDetail]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return dossiers;
    return dossiers.filter(d => {
      return [d.userId, d.displayName, d.realName, d.role]
        .filter((v): v is string => Boolean(v))
        .some(v => v.toLowerCase().includes(q));
    });
  }, [dossiers, search]);

  async function saveField(field: 'role' | 'notes', value: string | null) {
    if (!selectedUserId) return;
    setSavingField(field);
    setError(null);
    try {
      await invoke('save_dossier_field', { userId: selectedUserId, field, value });
      await loadDetail(selectedUserId);
      await loadList();
    } catch (err) {
      setError(`Save failed: ${String(err)}`);
    } finally {
      setSavingField(null);
    }
  }

  async function forgetField(field: DossierForgetField) {
    if (!selectedUserId) return;
    if (field === 'all' && !window.confirm('Wipe this entire dossier? This cannot be undone.')) {
      return;
    }
    setSavingField(`forget:${field}`);
    setError(null);
    try {
      await invoke('forget_dossier_field', { userId: selectedUserId, field });
      if (field === 'all') {
        setSelectedUserId(null);
      } else {
        await loadDetail(selectedUserId);
      }
      await loadList();
    } catch (err) {
      setError(`Forget failed: ${String(err)}`);
    } finally {
      setSavingField(null);
    }
  }

  return (
    <div className="page page-dossiers">
      <PageIntro
        eyebrow="Memory"
        title="Dossiers"
        description="Per-Slack-user identity, project affinity, and tone preferences that miniOG accumulates over time."
        actions={
          <button type="button" className="btn-secondary" onClick={() => void loadList()} disabled={loadingList}>
            {loadingList ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      {error ? (
        <div className="callout callout-warning" role="alert">
          {error}
        </div>
      ) : null}

      <div
        className="dossier-layout"
        style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) 2fr', gap: '1.25rem' }}
      >
        <GlowCard>
          <section className="surface-card">
            <div className="section-head">
              <h2>Users</h2>
              <span className="muted">{filtered.length}</span>
            </div>
            <div style={{ padding: '0 1rem 0.75rem' }}>
              <input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter by name, id, or role"
                className="input"
                style={{ width: '100%' }}
              />
            </div>
            <ul
              className="dossier-list"
              style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '60vh', overflowY: 'auto' }}
            >
              {filtered.length === 0 ? (
                <li className="muted" style={{ padding: '1rem' }}>
                  {loadingList ? 'Loading…' : 'No dossiers yet.'}
                </li>
              ) : (
                filtered.map(d => {
                  const active = selectedUserId === d.userId;
                  return (
                    <li key={d.userId}>
                      <button
                        type="button"
                        onClick={() => setSelectedUserId(d.userId)}
                        className={active ? 'list-item list-item-active' : 'list-item'}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '0.6rem 1rem',
                          background: active ? 'var(--surface-emphasis, rgba(255,255,255,0.06))' : 'transparent',
                          border: 'none',
                          color: 'inherit',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                          <strong>{d.displayName ?? d.realName ?? d.userId}</strong>
                          {d.role ? <span className="badge">{d.role}</span> : null}
                        </div>
                        <div className="muted" style={{ fontSize: '0.75rem' }}>
                          <span>{d.userId}</span>
                          {d.tz ? <span> · {d.tz}</span> : null}
                          <span> · </span>
                          <Timestamp value={d.updatedAt} />
                        </div>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </section>
        </GlowCard>

        <GlowCard>
          <section className="surface-card">
            <div className="section-head">
              <h2>Detail</h2>
              {detail ? <span className="muted">{detail.userId}</span> : null}
            </div>
            <div style={{ padding: '1rem' }}>
              {!selectedUserId ? (
                <p className="muted">Select a user from the left to inspect their dossier.</p>
              ) : loadingDetail || !detail ? (
                <p className="muted">Loading…</p>
              ) : (
                <div style={{ display: 'grid', gap: '1rem' }}>
                  <div>
                    <h3 style={{ marginBottom: '0.4rem' }}>{detail.displayName ?? detail.realName ?? detail.userId}</h3>
                    <div className="muted" style={{ fontSize: '0.85rem' }}>
                      {detail.email ? <span>{detail.email} · </span> : null}
                      {detail.tz ? <span>{detail.tz} · </span> : null}
                      {detail.firstSeenAt ? (
                        <span>
                          first seen <Timestamp value={detail.firstSeenAt} />
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div>
                    <label className="muted" style={{ display: 'block', marginBottom: '0.3rem' }}>
                      Role
                    </label>
                    <select
                      value={detail.role ?? ''}
                      onChange={e => void saveField('role', e.target.value || null)}
                      disabled={savingField === 'role'}
                      className="input"
                    >
                      <option value="">— none —</option>
                      {ROLES.map(role => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="muted" style={{ display: 'block', marginBottom: '0.3rem' }}>
                      Notes
                    </label>
                    <textarea
                      value={notesDraft}
                      onChange={e => setNotesDraft(e.target.value)}
                      placeholder="Operator notes (visible only in Watchtower)"
                      rows={3}
                      className="input"
                      style={{ width: '100%' }}
                    />
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => void saveField('notes', notesDraft)}
                        disabled={savingField === 'notes'}
                      >
                        {savingField === 'notes' ? 'Saving…' : 'Save notes'}
                      </button>
                    </div>
                  </div>

                  <div>
                    <h4>Tone</h4>
                    <p className="muted" style={{ fontSize: '0.85rem' }}>
                      {detail.tone ?? 'normal'} {detail.toneSource ? <span>· source: {detail.toneSource}</span> : null}
                    </p>
                  </div>

                  <div>
                    <h4>Project affinity</h4>
                    {detail.affinity.length === 0 ? (
                      <p className="muted">No data yet.</p>
                    ) : (
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            <th align="left">Repo</th>
                            <th align="right">Hits</th>
                            <th align="right">Success</th>
                            <th align="right">Fail</th>
                            <th align="left">Last used</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.affinity.map(a => (
                            <tr key={a.repo}>
                              <td>{a.repo}</td>
                              <td align="right">{a.hits}</td>
                              <td align="right">{a.successes}</td>
                              <td align="right">{a.failures}</td>
                              <td>{a.lastUsedAt ? <Timestamp value={a.lastUsedAt} /> : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  <div>
                    <h4>Metrics</h4>
                    {detail.metrics.length === 0 ? (
                      <p className="muted">No metrics yet.</p>
                    ) : (
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {detail.metrics.map(m => (
                          <li key={m.metricKey} style={{ marginBottom: '0.5rem' }}>
                            <strong>{m.metricKey}</strong>
                            <pre style={{ margin: '0.2rem 0 0', fontSize: '0.75rem', overflowX: 'auto' }}>
                              {prettyJson(m.metricValue)}
                            </pre>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <h4>Forget</h4>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      {FORGET_FIELDS.map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          className={value === 'all' ? 'btn-danger' : 'btn-secondary'}
                          onClick={() => void forgetField(value)}
                          disabled={savingField === `forget:${value}`}
                        >
                          {savingField === `forget:${value}` ? '…' : label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </GlowCard>
      </div>
    </div>
  );
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
