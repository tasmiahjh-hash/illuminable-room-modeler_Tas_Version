import { useEffect, useState, useCallback } from 'react';
import {
  X, ShieldCheck, Users, Search, RefreshCw, Loader2, AlertTriangle, Send,
  Trash2, RotateCcw, Wrench, History, Database, CheckCircle2, Copy, ArrowRightLeft,
} from 'lucide-react';
import * as adminClient from './adminClient.js';

// AdminDashboard: the Research Admin Dashboard's entire UI — Users, Graphs
// (across every owner), Diagnostics, and per-graph actions (view details,
// repair, restore version, delete/restore, edit metadata, push to user)
// plus per-user actions (message/push update). Every one of these actions
// is a thin call into adminClient.js, which talks to server/api/adminRoutes.js
// — the actual access control lives there (role === 'admin', re-checked on
// every request against a fresh database read), never here. This component
// being reachable at all already implies auth.role === 'admin' (see
// App.jsx's own render-gate), but that gate is convenience/UX only, not a
// security boundary — see adminClient.js's own module comment.
//
// This file owns no plotting/geometry logic and never will — "Repair
// Graph" is a data-integrity-only server operation (see repairGraph's own
// comment in graphRepository.js); this component just shows its result.

const TABS = { USERS: 'users', GRAPHS: 'graphs', DIAGNOSTICS: 'diagnostics' };

const fieldClass = 'bg-[#0b1016] border border-white/10 rounded-md px-2 py-1.5 text-xs font-mono text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/50';
const btnClass = 'inline-flex items-center gap-1 rounded-md border border-white/10 bg-[#0b1016] px-2 py-1 text-[11px] font-bold text-slate-300 hover:text-cyan-200 hover:border-cyan-300/40 transition-colors disabled:opacity-40 disabled:pointer-events-none';
const dangerBtnClass = 'inline-flex items-center gap-1 rounded-md border border-red-400/25 bg-red-500/10 px-2 py-1 text-[11px] font-bold text-red-300 hover:text-red-200 hover:border-red-300/50 transition-colors disabled:opacity-40 disabled:pointer-events-none';

/** "seen in the last few minutes" — the presence heuristic userRepository.js's own touchLastSeen backs (no websockets — see that file's own comment). */
const isOnline = (lastSeenAt) => {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < 5 * 60 * 1000;
};

const ErrorBanner = ({ error }) => {
  if (!error) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
    </div>
  );
};

/** Inline recipient picker + confirm — used by both the Users and Graphs tabs' own "Push to User" action. */
const PushToUserControl = ({ graphId, users, onPushed }) => {
  const [open, setOpen] = useState(false);
  const [recipientId, setRecipientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  if (!open) {
    return (
      <button type="button" className={btnClass} onClick={() => setOpen(true)} title="Push this graph to another user">
        <Send className="h-3 w-3" /> Push to User
      </button>
    );
  }

  const confirm = async () => {
    if (!recipientId) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await adminClient.pushGraphToUser(graphId, recipientId);
      setResult(res.pushed ? 'Pushed — the user was notified in their inbox.' : 'That user already had access to this graph.');
      onPushed?.();
    } catch (err) {
      setResult(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select className={fieldClass} value={recipientId} onChange={(e) => setRecipientId(e.target.value)}>
        <option value="">Choose recipient…</option>
        {users.map((u) => <option key={u.id} value={u.id}>{u.displayName || u.email}</option>)}
      </select>
      <button type="button" className={btnClass} disabled={!recipientId || busy} onClick={confirm}>
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} Confirm
      </button>
      <button type="button" className="text-[11px] text-slate-500 hover:text-slate-300" onClick={() => { setOpen(false); setResult(null); }}>cancel</button>
      {result && <span className="text-[11px] font-semibold text-cyan-200">{result}</span>}
    </div>
  );
};

export default function AdminDashboard({ isOpen, onClose }) {
  const [tab, setTab] = useState(TABS.USERS);

  // Every user, for the picker in PushToUserControl above and the Users
  // tab's own table — one fetch, shared, refreshed on demand (see refreshUsers).
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState(null);
  const [userSearch, setUserSearch] = useState('');

  const refreshUsers = useCallback(async (q) => {
    setUsersLoading(true);
    setUsersError(null);
    try {
      const res = await adminClient.listUsers(q || undefined);
      setUsers(res.users);
    } catch (err) {
      setUsersError(err.message);
    } finally {
      setUsersLoading(false);
    }
  }, []);

  // Deferred via setTimeout(fn, 0) — not a debounce, but so this effect
  // never calls refreshUsers (and, through it, setState) synchronously
  // within the effect body itself, matching useGraphLibrary.js's own
  // identical fix for the same react-hooks/set-state-in-effect rule.
  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = setTimeout(() => { refreshUsers(); }, 0);
    return () => clearTimeout(timer);
  }, [isOpen, refreshUsers]);

  // "Users -> select user -> View Database -> Push Graph to User."
  const [viewingUserId, setViewingUserId] = useState(null);
  const [userGraphs, setUserGraphs] = useState([]);
  const [userGraphsLoading, setUserGraphsLoading] = useState(false);
  const [userGraphsError, setUserGraphsError] = useState(null);

  const refreshUserGraphs = useCallback(async (userId) => {
    if (!userId) return;
    setUserGraphsLoading(true);
    setUserGraphsError(null);
    try {
      const res = await adminClient.listUserGraphs(userId);
      setUserGraphs(res.graphs);
    } catch (err) {
      setUserGraphsError(err.message);
    } finally {
      setUserGraphsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!viewingUserId) return undefined;
    const timer = setTimeout(() => { refreshUserGraphs(viewingUserId); }, 0);
    return () => clearTimeout(timer);
  }, [viewingUserId, refreshUserGraphs]);

  // Message User / Push Update — a small inline form under the selected user.
  const [messageDraft, setMessageDraft] = useState('');
  const [messageBusy, setMessageBusy] = useState(false);
  const [messageResult, setMessageResult] = useState(null);
  const sendMessage = async (userId, messageType) => {
    if (!messageDraft.trim()) return;
    setMessageBusy(true);
    setMessageResult(null);
    try {
      await adminClient.messageUser(userId, messageDraft.trim(), messageType);
      setMessageResult('Sent.');
      setMessageDraft('');
    } catch (err) {
      setMessageResult(err.message);
    } finally {
      setMessageBusy(false);
    }
  };

  // All Graphs (across every owner) tab.
  const [graphSearch, setGraphSearch] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [graphs, setGraphs] = useState([]);
  const [graphsLoading, setGraphsLoading] = useState(false);
  const [graphsError, setGraphsError] = useState(null);

  const refreshGraphs = useCallback(async () => {
    setGraphsLoading(true);
    setGraphsError(null);
    try {
      const res = await adminClient.listAllGraphs({ code: graphSearch || undefined, includeDeleted: includeDeleted ? 'true' : undefined });
      setGraphs(res.graphs);
    } catch (err) {
      setGraphsError(err.message);
    } finally {
      setGraphsLoading(false);
    }
  }, [graphSearch, includeDeleted]);

  useEffect(() => {
    if (!isOpen || tab !== TABS.GRAPHS) return undefined;
    const timer = setTimeout(() => { refreshGraphs(); }, 0);
    return () => clearTimeout(timer);
  }, [isOpen, tab, refreshGraphs]);

  // Diagnostics tab.
  const [diagnostics, setDiagnostics] = useState(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState(null);

  const refreshDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    setDiagnosticsError(null);
    try {
      const [failedJobs, corruptedGraphs, duplicateGraphs] = await Promise.all([
        adminClient.listFailedJobs(), adminClient.listCorruptedGraphs(), adminClient.listDuplicateGraphs(),
      ]);
      setDiagnostics({ failedJobs: failedJobs.failedJobs, corruptedGraphs: corruptedGraphs.corruptedGraphs, duplicateGraphs: duplicateGraphs.duplicateGraphs });
    } catch (err) {
      setDiagnosticsError(err.message);
    } finally {
      setDiagnosticsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen || tab !== TABS.DIAGNOSTICS) return undefined;
    const timer = setTimeout(() => { refreshDiagnostics(); }, 0);
    return () => clearTimeout(timer);
  }, [isOpen, tab, refreshDiagnostics]);

  // Graph details drawer — shared by both the Users and Graphs tabs.
  const [detailsGraphId, setDetailsGraphId] = useState(null);
  const [details, setDetails] = useState(null);
  const [versions, setVersions] = useState([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionResult, setActionResult] = useState(null);
  const [metadataDraft, setMetadataDraft] = useState(null);

  const openDetails = useCallback(async (graphId) => {
    setDetailsGraphId(graphId);
    setDetailsLoading(true);
    setDetailsError(null);
    setActionResult(null);
    try {
      const [detailsRes, versionsRes] = await Promise.all([adminClient.getGraphDetails(graphId), adminClient.listGraphVersions(graphId)]);
      setDetails(detailsRes);
      setVersions(versionsRes.versions);
      setMetadataDraft({
        title: detailsRes.graph.title ?? '', description: detailsRes.graph.description ?? '',
        tags: (detailsRes.graph.tags ?? []).join(', '), notes: detailsRes.graph.notes ?? '',
        favorite: Boolean(detailsRes.graph.favorite), visibility: detailsRes.graph.visibility ?? 'private',
      });
    } catch (err) {
      setDetailsError(err.message);
    } finally {
      setDetailsLoading(false);
    }
  }, []);

  const closeDetails = () => { setDetailsGraphId(null); setDetails(null); setVersions([]); setMetadataDraft(null); };

  const refreshAfterAction = async () => {
    if (detailsGraphId) await openDetails(detailsGraphId);
    if (viewingUserId) refreshUserGraphs(viewingUserId);
    if (tab === TABS.GRAPHS) refreshGraphs();
    if (tab === TABS.DIAGNOSTICS) refreshDiagnostics();
  };

  const runAction = async (fn, successMessage) => {
    setActionBusy(true);
    setActionResult(null);
    try {
      await fn();
      setActionResult(successMessage);
      await refreshAfterAction();
    } catch (err) {
      setActionResult(err.message);
    } finally {
      setActionBusy(false);
    }
  };

  const saveMetadata = () => runAction(() => adminClient.updateGraphMetadata(detailsGraphId, {
    title: metadataDraft.title, description: metadataDraft.description,
    tags: metadataDraft.tags.split(',').map((t) => t.trim()).filter(Boolean),
    notes: metadataDraft.notes, favorite: metadataDraft.favorite, visibility: metadataDraft.visibility,
  }), 'Metadata saved.');

  if (!isOpen) return null;

  const filteredUsers = users;

  return (
    <div className="fixed inset-0 z-[91] flex items-center justify-center bg-black/60 p-4" role="presentation" onMouseDown={onClose}>
      <section
        role="dialog" aria-modal="true" aria-labelledby="admin-dashboard-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-6xl max-h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-xl border border-amber-300/25 bg-[#151c24] shadow-[0_24px_80px_rgba(0,0,0,0.62)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4 shrink-0">
          <div>
            <h2 id="admin-dashboard-title" className="flex items-center gap-2 text-sm font-bold text-amber-200">
              <ShieldCheck className="h-4 w-4" /> Research Admin Dashboard
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Every route here is enforced on the server by role === 'admin' — never just hidden in this UI.
            </p>
          </div>
          <button type="button" onClick={onClose} className="flex items-center justify-center rounded-md border border-white/10 bg-[#0b1016] p-1.5 text-slate-400 hover:text-red-300 hover:border-red-300/40 transition-colors" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex gap-1 border-b border-white/10 px-5 pt-3 shrink-0">
          {[[TABS.USERS, 'Users', Users], [TABS.GRAPHS, 'All Graphs', Database], [TABS.DIAGNOSTICS, 'Diagnostics', AlertTriangle]].map(([id, label, Icon]) => (
            <button
              key={id} type="button" onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-bold transition-colors ${tab === id ? 'border-white/15 bg-[#0f1520] text-amber-200' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === TABS.USERS && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <div className="relative flex-1 max-w-xs">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    className={`${fieldClass} w-full pl-7`} placeholder="Search email or name…"
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') refreshUsers(userSearch); }}
                  />
                </div>
                <button type="button" className={btnClass} onClick={() => refreshUsers(userSearch)} disabled={usersLoading}>
                  {usersLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Refresh
                </button>
              </div>
              <ErrorBanner error={usersError} />
              <div className="overflow-x-auto rounded-md border border-white/10">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#0b1016] text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-bold">User</th>
                      <th className="px-3 py-2 font-bold">Role</th>
                      <th className="px-3 py-2 font-bold">Graphs</th>
                      <th className="px-3 py-2 font-bold">Status</th>
                      <th className="px-3 py-2 font-bold">Joined</th>
                      <th className="px-3 py-2 font-bold"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filteredUsers.map((u) => (
                      <tr key={u.id} className="text-slate-300">
                        <td className="px-3 py-2">
                          <div className="font-semibold text-slate-100">{u.displayName}</div>
                          <div className="text-slate-500">{u.email}</div>
                        </td>
                        <td className="px-3 py-2">{u.role}</td>
                        <td className="px-3 py-2 font-mono">{u.graphCount}</td>
                        <td className="px-3 py-2">
                          {isOnline(u.lastSeenAt)
                            ? <span className="inline-flex items-center gap-1 text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Online</span>
                            : <span className="text-slate-500">{u.lastSeenAt ? `Seen ${new Date(u.lastSeenAt).toLocaleString()}` : 'Never seen'}</span>}
                        </td>
                        <td className="px-3 py-2 text-slate-500">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
                        <td className="px-3 py-2">
                          <button type="button" className={btnClass} onClick={() => setViewingUserId(viewingUserId === u.id ? null : u.id)}>
                            {viewingUserId === u.id ? 'Hide Database' : 'View Database'}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {filteredUsers.length === 0 && !usersLoading && (
                      <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">No users found.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {viewingUserId && (
                <div className="rounded-md border border-white/10 bg-[#0f1520] p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-xs font-bold text-cyan-200">
                      {users.find((u) => u.id === viewingUserId)?.displayName || viewingUserId}'s Graph Database
                    </h3>
                    <button type="button" className={btnClass} onClick={() => refreshUserGraphs(viewingUserId)} disabled={userGraphsLoading}>
                      {userGraphsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Refresh
                    </button>
                  </div>
                  <ErrorBanner error={userGraphsError} />
                  <div className="flex flex-col gap-2">
                    {userGraphs.map((g) => (
                      <div key={g.hash} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-white/5 bg-[#0b1016] px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[11px] text-slate-200">{g.title || g.hash}</div>
                          <div className="truncate text-[10px] text-slate-500">{g.pointCount} pts · {g.visibility}{g.deletedAt ? ' · deleted' : ''}</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button type="button" className={btnClass} onClick={() => openDetails(g.id)}><History className="h-3 w-3" /> Details</button>
                          <PushToUserControl graphId={g.id} users={users.filter((u) => u.id !== viewingUserId)} onPushed={() => refreshUserGraphs(viewingUserId)} />
                        </div>
                      </div>
                    ))}
                    {userGraphs.length === 0 && !userGraphsLoading && <p className="text-[11px] text-slate-500">No graphs owned by this user.</p>}
                  </div>

                  <div className="mt-3 flex items-center gap-2 border-t border-white/5 pt-3">
                    <input
                      className={`${fieldClass} flex-1`} placeholder="Message this user…"
                      value={messageDraft} onChange={(e) => setMessageDraft(e.target.value)}
                    />
                    <button type="button" className={btnClass} disabled={messageBusy || !messageDraft.trim()} onClick={() => sendMessage(viewingUserId, 'admin_message')}>Message User</button>
                    <button type="button" className={btnClass} disabled={messageBusy || !messageDraft.trim()} onClick={() => sendMessage(viewingUserId, 'push_update')}>Push Update</button>
                    {messageResult && <span className="text-[11px] font-semibold text-cyan-200">{messageResult}</span>}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === TABS.GRAPHS && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 max-w-xs">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    className={`${fieldClass} w-full pl-7`} placeholder="Search by code sequence…"
                    value={graphSearch} onChange={(e) => setGraphSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') refreshGraphs(); }}
                  />
                </div>
                <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-400">
                  <input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} /> Include deleted
                </label>
                <button type="button" className={btnClass} onClick={refreshGraphs} disabled={graphsLoading}>
                  {graphsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Refresh
                </button>
              </div>
              <ErrorBanner error={graphsError} />
              <div className="flex flex-col gap-2">
                {graphs.map((g) => (
                  <div key={g.hash} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-white/10 bg-[#0f1520] px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px] text-slate-200">{g.title || g.hash}</div>
                      <div className="truncate text-[10px] text-slate-500">
                        owner: {g.ownerDisplayName || g.ownerEmail || 'unowned'} · {g.pointCount} pts · {g.visibility}{g.deletedAt ? ' · deleted' : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button type="button" className={btnClass} onClick={() => openDetails(g.id)}><History className="h-3 w-3" /> Details</button>
                      <PushToUserControl graphId={g.id} users={users} onPushed={refreshGraphs} />
                    </div>
                  </div>
                ))}
                {graphs.length === 0 && !graphsLoading && <p className="text-[11px] text-slate-500">No graphs found.</p>}
              </div>
            </div>
          )}

          {tab === TABS.DIAGNOSTICS && (
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-end">
                <button type="button" className={btnClass} onClick={refreshDiagnostics} disabled={diagnosticsLoading}>
                  {diagnosticsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Refresh
                </button>
              </div>
              <ErrorBanner error={diagnosticsError} />

              <section>
                <h3 className="mb-2 text-xs font-bold text-red-300">Failed Jobs ({diagnostics?.failedJobs.length ?? 0})</h3>
                <div className="flex flex-col gap-1.5">
                  {diagnostics?.failedJobs.map((j) => (
                    <div key={j.jobId} className="rounded-md border border-red-400/20 bg-red-500/5 px-3 py-2 text-[11px] text-slate-300">
                      <span className="font-mono">{j.graphTitle || j.graphHash}</span> — {j.errorMessage || 'no error message recorded'}
                    </div>
                  ))}
                  {diagnostics && diagnostics.failedJobs.length === 0 && <p className="text-[11px] text-slate-500">No failed jobs.</p>}
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-bold text-amber-300">Corrupted Graphs ({diagnostics?.corruptedGraphs.length ?? 0})</h3>
                <div className="flex flex-col gap-1.5">
                  {diagnostics?.corruptedGraphs.map((c) => (
                    <div key={c.geometryId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-400/20 bg-amber-500/5 px-3 py-2 text-[11px] text-slate-300">
                      <span><span className="font-mono">{c.graphTitle || c.graphHash}</span> — stored {c.storedPointCount} pts, actual {c.actualPointCount}</span>
                      <button type="button" className={btnClass} onClick={() => runAction(() => adminClient.repairGraph(c.graphId), 'Repaired.')}>
                        <Wrench className="h-3 w-3" /> Repair
                      </button>
                    </div>
                  ))}
                  {diagnostics && diagnostics.corruptedGraphs.length === 0 && <p className="text-[11px] text-slate-500">No corrupted graphs.</p>}
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-bold text-cyan-300">Duplicate Hash Diagnostics ({diagnostics?.duplicateGraphs.length ?? 0})</h3>
                <p className="mb-2 text-[10px] text-slate-500">
                  graphs.hash is UNIQUE, so a literal collision is impossible — this surfaces the same parameters stored under more than one hash (a different algorithm version) instead.
                </p>
                <div className="flex flex-col gap-1.5">
                  {diagnostics?.duplicateGraphs.map((d, i) => (
                    <div key={i} className="rounded-md border border-cyan-400/20 bg-cyan-500/5 px-3 py-2 text-[11px] text-slate-300">
                      <Copy className="mr-1 inline h-3 w-3" /> {d.params.sequenceText} — {d.duplicateCount} versions ({d.graphs.map((x) => `alg v${x.algorithmVersion}`).join(', ')})
                    </div>
                  ))}
                  {diagnostics && diagnostics.duplicateGraphs.length === 0 && <p className="text-[11px] text-slate-500">No duplicate parameter sets.</p>}
                </div>
              </section>
            </div>
          )}
        </div>
      </section>

      {detailsGraphId && (
        <div className="fixed inset-0 z-[92] flex items-center justify-center bg-black/70 p-4" role="presentation" onMouseDown={closeDetails}>
          <section
            role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}
            className="flex w-full max-w-2xl max-h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-xl border border-white/15 bg-[#151c24] shadow-[0_24px_80px_rgba(0,0,0,0.62)]"
          >
            <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 shrink-0">
              <h3 className="text-xs font-bold text-cyan-100">Graph Details</h3>
              <button type="button" onClick={closeDetails} className="text-slate-400 hover:text-red-300"><X className="h-4 w-4" /></button>
            </header>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {detailsLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
              <ErrorBanner error={detailsError} />
              {details && metadataDraft && (
                <div className="flex flex-col gap-3 text-xs">
                  <div className="rounded-md border border-white/10 bg-[#0b1016] p-3 font-mono text-[11px] text-slate-400">
                    <div>hash: {details.graph.hash}</div>
                    <div>points: {details.geometry?.pointCount ?? details.geometry?.points?.length ?? 0}</div>
                    <div>status: {details.geometry?.status ?? '—'}</div>
                    <div>owner: {details.graph.ownerUserId ?? 'unowned'}</div>
                    <div>version: {details.graph.currentVersion}</div>
                    {details.graph.deletedAt && <div className="text-red-300">deleted at {details.graph.deletedAt}</div>}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-slate-500">Title</span>
                      <input className={fieldClass} value={metadataDraft.title} onChange={(e) => setMetadataDraft((d) => ({ ...d, title: e.target.value }))} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-slate-500">Visibility</span>
                      <select className={fieldClass} value={metadataDraft.visibility} onChange={(e) => setMetadataDraft((d) => ({ ...d, visibility: e.target.value }))}>
                        <option value="private">private</option>
                        <option value="shared">shared</option>
                        <option value="public">public</option>
                      </select>
                    </label>
                    <label className="col-span-2 flex flex-col gap-1">
                      <span className="text-slate-500">Description</span>
                      <input className={fieldClass} value={metadataDraft.description} onChange={(e) => setMetadataDraft((d) => ({ ...d, description: e.target.value }))} />
                    </label>
                    <label className="col-span-2 flex flex-col gap-1">
                      <span className="text-slate-500">Tags (comma-separated)</span>
                      <input className={fieldClass} value={metadataDraft.tags} onChange={(e) => setMetadataDraft((d) => ({ ...d, tags: e.target.value }))} />
                    </label>
                    <label className="col-span-2 flex flex-col gap-1">
                      <span className="text-slate-500">Notes</span>
                      <input className={fieldClass} value={metadataDraft.notes} onChange={(e) => setMetadataDraft((d) => ({ ...d, notes: e.target.value }))} />
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button type="button" className={btnClass} disabled={actionBusy} onClick={saveMetadata}><CheckCircle2 className="h-3 w-3" /> Save Metadata</button>
                    <button type="button" className={btnClass} disabled={actionBusy} onClick={() => runAction(() => adminClient.repairGraph(detailsGraphId), 'Repaired.')}><Wrench className="h-3 w-3" /> Repair Graph</button>
                    {details.graph.deletedAt ? (
                      <button type="button" className={btnClass} disabled={actionBusy} onClick={() => runAction(() => adminClient.restoreGraph(detailsGraphId), 'Restored.')}><RotateCcw className="h-3 w-3" /> Restore Graph</button>
                    ) : (
                      <button type="button" className={dangerBtnClass} disabled={actionBusy} onClick={() => runAction(() => adminClient.deleteGraph(detailsGraphId), 'Deleted.')}><Trash2 className="h-3 w-3" /> Delete Graph</button>
                    )}
                    <PushToUserControl graphId={detailsGraphId} users={users} onPushed={refreshAfterAction} />
                    {actionResult && <span className="text-[11px] font-semibold text-cyan-200">{actionResult}</span>}
                  </div>

                  <div>
                    <h4 className="mb-1.5 flex items-center gap-1 text-[11px] font-bold text-slate-400"><ArrowRightLeft className="h-3 w-3" /> Version History</h4>
                    <div className="flex flex-col gap-1">
                      {versions.map((v) => (
                        <div key={v.id} className="flex items-center justify-between gap-2 rounded-md border border-white/5 bg-[#0b1016] px-2.5 py-1.5 text-[11px] text-slate-400">
                          <span>v{v.versionNumber} · {v.changeReason} · {new Date(v.createdAt).toLocaleString()}</span>
                          <button type="button" className={btnClass} disabled={actionBusy} onClick={() => runAction(() => adminClient.restoreGraphVersion(detailsGraphId, v.versionNumber), `Restored to v${v.versionNumber}.`)}>Restore</button>
                        </div>
                      ))}
                      {versions.length === 0 && <p className="text-[11px] text-slate-500">No saved versions yet.</p>}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
