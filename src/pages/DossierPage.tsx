import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { GlowCard } from '../components/GlowCard';
import { PageIntro } from '../components/primitives';
import { Timestamp } from '../components/Timestamp';
import type { DossierDetail, DossierForgetField, DossierRole, DossierSummary, PinnedFact, UserMemory } from '../types';

const ROLES: DossierRole[] = ['pm', 'dev', 'designer', 'ops'];

type DetailTab = 'overview' | 'memory' | 'notes' | 'activity' | 'danger';

const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'memory', label: 'Memory' },
  { id: 'notes', label: 'Notes' },
  { id: 'activity', label: 'Activity' },
  { id: 'danger', label: 'Danger' },
];

const FORGET_FIELDS: Array<{ value: Exclude<DossierForgetField, 'all'>; label: string; hint: string }> = [
  { value: 'role', label: 'Role', hint: 'Clear assigned role' },
  { value: 'tone', label: 'Tone', hint: 'Reset tone preference' },
  { value: 'notes', label: 'Notes', hint: 'Wipe operator notes' },
  { value: 'project_affinity', label: 'Project affinity', hint: 'Clear repo usage history' },
  { value: 'metrics', label: 'Metrics', hint: 'Drop computed metric snapshot' },
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
  const [pinnedFacts, setPinnedFacts] = useState<PinnedFact[]>([]);
  const [memories, setMemories] = useState<UserMemory[]>([]);
  const [pinnedDraft, setPinnedDraft] = useState('');
  const [savingPinned, setSavingPinned] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');

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
      const [result, facts, mem] = await Promise.all([
        invoke<DossierDetail>('get_dossier', { userId }),
        invoke<PinnedFact[]>('list_pinned_facts', { userId }),
        invoke<UserMemory[]>('get_user_memories', { userId, limit: 30 }),
      ]);
      setDetail(result);
      setNotesDraft(result.notes ?? '');
      setPinnedFacts(facts);
      setMemories(mem);
    } catch (err) {
      setError(`Failed to load dossier: ${String(err)}`);
      setDetail(null);
      setPinnedFacts([]);
      setMemories([]);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedUserId) {
      setActiveTab('overview');
      void loadDetail(selectedUserId);
    } else {
      setDetail(null);
      setNotesDraft('');
      setPinnedFacts([]);
      setMemories([]);
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

  async function addPinnedFact() {
    if (!selectedUserId) return;
    const text = pinnedDraft.trim();
    if (!text) return;
    setSavingPinned(true);
    setError(null);
    try {
      await invoke<PinnedFact>('add_pinned_fact', { userId: selectedUserId, text });
      setPinnedDraft('');
      await loadDetail(selectedUserId);
    } catch (err) {
      setError(`Pin failed: ${String(err)}`);
    } finally {
      setSavingPinned(false);
    }
  }

  async function removePinnedFact(id: number) {
    if (!selectedUserId) return;
    setError(null);
    try {
      await invoke('remove_pinned_fact', { userId: selectedUserId, id });
      await loadDetail(selectedUserId);
    } catch (err) {
      setError(`Remove failed: ${String(err)}`);
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

  const totalActivity = useMemo(() => {
    if (!detail) return 0;
    return detail.affinity.reduce((sum, a) => sum + a.hits, 0);
  }, [detail]);

  const topRepo = useMemo(() => {
    if (!detail || detail.affinity.length === 0) return null;
    return [...detail.affinity].sort((a, b) => b.hits - a.hits)[0];
  }, [detail]);

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Memory"
        title="Dossiers"
        description="Per-Slack-user identity, project affinity, and tone preferences that miniOG accumulates over time."
        actions={
          <button type="button" className="ghost-button" onClick={() => void loadList()} disabled={loadingList}>
            {loadingList ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      {error ? <div className="inline-error-banner">{error}</div> : null}

      <div className="dossier-workspace">
        <GlowCard>
          <section className="surface-card dossier-sidebar">
            <div className="section-head">
              <div className="section-heading-copy">
                <div className="section-title-row">
                  <h2>Users</h2>
                  <span className="section-count">{filtered.length}</span>
                </div>
                <p className="muted">Filter by name, id, or role.</p>
              </div>
            </div>

            <div className="dossier-search">
              <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" />
            </div>

            <div className="dossier-user-list">
              {filtered.length === 0 ? (
                <p className="empty-state">{loadingList ? 'Loading…' : 'No dossiers yet.'}</p>
              ) : (
                <ul className="run-list">
                  {filtered.map(d => {
                    const active = selectedUserId === d.userId;
                    const name = d.displayName ?? d.realName ?? d.userId;
                    return (
                      <li key={d.userId}>
                        <button
                          type="button"
                          onClick={() => setSelectedUserId(d.userId)}
                          className={active ? 'run-card selected' : 'run-card'}
                        >
                          <div className="run-card-copy">
                            <div className="dossier-card-header">
                              <span className="run-card-title">{name}</span>
                              {d.role ? <span className="status-badge info">{d.role}</span> : null}
                            </div>
                            <div className="run-card-meta">
                              <span>{d.userId}</span>
                              <span> · </span>
                              <Timestamp value={d.updatedAt} />
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        </GlowCard>

        <GlowCard>
          <section className="surface-card dossier-detail">
            {!selectedUserId ? (
              <p className="empty-state">Select a user from the left to inspect their dossier.</p>
            ) : loadingDetail || !detail ? (
              <p className="empty-state">Loading…</p>
            ) : (
              <>
                <header className="dossier-hero">
                  <div className="dossier-hero-copy">
                    <span className="eyebrow">{detail.role ?? 'no role'}</span>
                    <h1>{detail.displayName ?? detail.realName ?? detail.userId}</h1>
                    <p className="dossier-hero-meta">
                      <span className="mono">{detail.userId}</span>
                      {detail.email ? (
                        <>
                          <span className="dot">·</span>
                          <span>{detail.email}</span>
                        </>
                      ) : null}
                      {detail.firstSeenAt ? (
                        <>
                          <span className="dot">·</span>
                          <span>
                            first seen <Timestamp value={detail.firstSeenAt} />
                          </span>
                        </>
                      ) : null}
                    </p>
                  </div>
                </header>

                <div className="detail-grid dossier-stats">
                  <div>
                    <span>Role</span>
                    <strong>{detail.role ?? '—'}</strong>
                  </div>
                  <div>
                    <span>Tone</span>
                    <strong>{detail.tone ?? 'normal'}</strong>
                  </div>
                  <div>
                    <span>Activity</span>
                    <strong>
                      {totalActivity} hit{totalActivity === 1 ? '' : 's'}
                    </strong>
                  </div>
                  <div>
                    <span>Top repo</span>
                    <strong>{topRepo ? topRepo.repo : '—'}</strong>
                  </div>
                  <div>
                    <span>Pinned facts</span>
                    <strong>{pinnedFacts.length}</strong>
                  </div>
                  <div>
                    <span>Memories</span>
                    <strong>{memories.length}</strong>
                  </div>
                </div>

                <nav className="tab-bar dossier-tabs" role="tablist" aria-label="Dossier sections">
                  {TABS.map(tab => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === tab.id}
                      className={activeTab === tab.id ? 'tab-button active' : 'tab-button'}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </nav>

                <div className="dossier-tab-panel">
                  {activeTab === 'overview' ? (
                    <OverviewTab
                      detail={detail}
                      role={detail.role}
                      onChangeRole={value => void saveField('role', value || null)}
                      savingRole={savingField === 'role'}
                    />
                  ) : null}

                  {activeTab === 'memory' ? (
                    <MemoryTab
                      pinnedFacts={pinnedFacts}
                      pinnedDraft={pinnedDraft}
                      onPinnedDraftChange={setPinnedDraft}
                      onAdd={() => void addPinnedFact()}
                      onRemove={id => void removePinnedFact(id)}
                      saving={savingPinned}
                    />
                  ) : null}

                  {activeTab === 'notes' ? (
                    <NotesTab
                      notesDraft={notesDraft}
                      onChange={setNotesDraft}
                      onSave={() => void saveField('notes', notesDraft)}
                      saving={savingField === 'notes'}
                    />
                  ) : null}

                  {activeTab === 'activity' ? <ActivityTab memories={memories} /> : null}

                  {activeTab === 'danger' ? (
                    <DangerTab busyField={savingField} onForget={field => void forgetField(field)} />
                  ) : null}
                </div>
              </>
            )}
          </section>
        </GlowCard>
      </div>
    </div>
  );
}

function OverviewTab({
  detail,
  role,
  onChangeRole,
  savingRole,
}: {
  detail: DossierDetail;
  role: DossierRole | null;
  onChangeRole: (value: string) => void;
  savingRole: boolean;
}) {
  return (
    <div className="dossier-tab-stack">
      <div className="dossier-field">
        <label className="dossier-field-label">Role</label>
        <select
          className="dossier-input"
          value={role ?? ''}
          onChange={e => onChangeRole(e.target.value)}
          disabled={savingRole}
        >
          <option value="">— none —</option>
          {ROLES.map(r => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {detail.toneSource ? <p className="muted dossier-field-hint">tone source: {detail.toneSource}</p> : null}
      </div>

      <div className="dossier-subsection">
        <div className="section-title-row">
          <h3>Project affinity</h3>
          <span className="section-count">{detail.affinity.length}</span>
        </div>
        {detail.affinity.length === 0 ? (
          <p className="empty-state">No project usage tracked yet.</p>
        ) : (
          <div className="dossier-table-wrap">
            <table className="dossier-table">
              <thead>
                <tr>
                  <th>Repo</th>
                  <th className="num">Hits</th>
                  <th className="num">Success</th>
                  <th className="num">Fail</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {detail.affinity.map(a => (
                  <tr key={a.repo}>
                    <td>{a.repo}</td>
                    <td className="num">{a.hits}</td>
                    <td className="num">{a.successes}</td>
                    <td className="num">{a.failures}</td>
                    <td>{a.lastUsedAt ? <Timestamp value={a.lastUsedAt} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="dossier-subsection">
        <div className="section-title-row">
          <h3>Metrics</h3>
          <span className="section-count">{detail.metrics.length}</span>
        </div>
        {detail.metrics.length === 0 ? (
          <p className="empty-state">No metrics computed yet.</p>
        ) : (
          <ul className="dossier-metric-list">
            {detail.metrics.map(m => (
              <li key={m.metricKey} className="dossier-metric">
                <span className="dossier-metric-key">{m.metricKey}</span>
                <pre className="dossier-metric-value">{prettyJson(m.metricValue)}</pre>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MemoryTab({
  pinnedFacts,
  pinnedDraft,
  onPinnedDraftChange,
  onAdd,
  onRemove,
  saving,
}: {
  pinnedFacts: PinnedFact[];
  pinnedDraft: string;
  onPinnedDraftChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (id: number) => void;
  saving: boolean;
}) {
  return (
    <div className="dossier-tab-stack">
      <div className="dossier-subsection">
        <div className="section-title-row">
          <h3>Things to remember</h3>
          <span className="section-count">{pinnedFacts.length}</span>
        </div>
        <p className="muted">Pinned facts miniOG always recalls when answering this user.</p>
      </div>

      <form
        className="dossier-pin-form"
        onSubmit={e => {
          e.preventDefault();
          onAdd();
        }}
      >
        <input
          type="text"
          className="dossier-input"
          placeholder="Add a fact for miniOG to remember…"
          value={pinnedDraft}
          onChange={e => onPinnedDraftChange(e.target.value)}
          maxLength={280}
        />
        <button type="submit" className="primary-button" disabled={saving || !pinnedDraft.trim()}>
          {saving ? 'Pinning…' : 'Pin'}
        </button>
      </form>

      {pinnedFacts.length === 0 ? (
        <p className="empty-state">
          No pinned facts yet. Add one above, or run <code>remember</code> in Slack.
        </p>
      ) : (
        <ul className="dossier-pin-list">
          {pinnedFacts.map(f => (
            <li key={f.id} className="dossier-pin-item">
              <div className="dossier-pin-body">
                <p className="dossier-pin-text">{f.text}</p>
                <p className="dossier-pin-meta">
                  <span className="mono">#{f.id}</span>
                  <span className="dot">·</span>
                  <span>{f.source}</span>
                  <span className="dot">·</span>
                  <Timestamp value={f.createdAt} />
                </p>
              </div>
              <button type="button" className="ghost-button" onClick={() => onRemove(f.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NotesTab({
  notesDraft,
  onChange,
  onSave,
  saving,
}: {
  notesDraft: string;
  onChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="dossier-tab-stack">
      <div className="dossier-subsection">
        <div className="section-title-row">
          <h3>Operator notes</h3>
        </div>
        <p className="muted">Private to Watchtower. miniOG does not see these.</p>
      </div>

      <textarea
        className="dossier-textarea"
        value={notesDraft}
        onChange={e => onChange(e.target.value)}
        placeholder="Anything you want to remember about this user (visible only here)"
        rows={6}
      />
      <div className="dossier-action-row">
        <button type="button" className="primary-button" onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save notes'}
        </button>
      </div>
    </div>
  );
}

function ActivityTab({ memories }: { memories: UserMemory[] }) {
  return (
    <div className="dossier-tab-stack">
      <div className="dossier-subsection">
        <div className="section-title-row">
          <h3>Recent work</h3>
          <span className="section-count">{memories.length}</span>
        </div>
        <p className="muted">Last 30 interactions miniOG handled for this user.</p>
      </div>

      {memories.length === 0 ? (
        <p className="empty-state">No tracked interactions yet.</p>
      ) : (
        <ul className="dossier-memory-list">
          {memories.map(m => (
            <li key={m.id} className="dossier-memory-item">
              <div className="dossier-memory-meta">
                <Timestamp value={m.createdAt} />
                <span className="dot">·</span>
                <span className="status-badge info">{m.workflow ?? 'WORK'}</span>
                {m.status ? (
                  <span
                    className={`status-badge ${m.status === 'SUCCESS' ? 'success' : m.status === 'FAILED' ? 'failed' : 'info'}`}
                  >
                    {m.status}
                  </span>
                ) : null}
                {m.repo ? (
                  <>
                    <span className="dot">·</span>
                    <span className="mono">{m.repo}</span>
                  </>
                ) : null}
                {m.product ? (
                  <>
                    <span className="dot">·</span>
                    <span>{m.product}</span>
                  </>
                ) : null}
              </div>
              <p className="dossier-memory-summary">
                {m.summary}
                {m.prUrl ? (
                  <>
                    {' '}
                    <a href={m.prUrl} target="_blank" rel="noreferrer">
                      [PR]
                    </a>
                  </>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DangerTab({
  busyField,
  onForget,
}: {
  busyField: string | null;
  onForget: (field: DossierForgetField) => void;
}) {
  return (
    <div className="dossier-tab-stack">
      <div className="dossier-subsection">
        <div className="section-title-row">
          <h3>Forget</h3>
        </div>
        <p className="muted">Reset individual fields, or wipe the entire dossier.</p>
      </div>

      <ul className="dossier-forget-list">
        {FORGET_FIELDS.map(({ value, label, hint }) => (
          <li key={value} className="dossier-forget-row">
            <div>
              <strong>{label}</strong>
              <p className="muted">{hint}</p>
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={() => onForget(value)}
              disabled={busyField === `forget:${value}`}
            >
              {busyField === `forget:${value}` ? '…' : 'Forget'}
            </button>
          </li>
        ))}
      </ul>

      <div className="dossier-danger-zone">
        <div>
          <strong>Wipe everything</strong>
          <p className="muted">Removes the entire dossier, pinned facts, and memory rows. Cannot be undone.</p>
        </div>
        <button
          type="button"
          className="dossier-danger-button"
          onClick={() => onForget('all')}
          disabled={busyField === 'forget:all'}
        >
          {busyField === 'forget:all' ? '…' : 'Forget everything'}
        </button>
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
