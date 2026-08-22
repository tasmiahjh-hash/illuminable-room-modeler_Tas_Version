import { useEffect, useState, useCallback, useMemo } from 'react';
import { X, FolderOpen, Search, RefreshCw, Loader2, AlertTriangle, ChevronDown, ChevronRight, Trash2, Cloud } from 'lucide-react';
import * as workspaceCloudClient from './workspaceCloudClient.js';

// WorkspaceLibraryPanel: "Load Saved Work" — the shared Cloud Workspace
// Library every signed-in user (student or professor/admin) can browse.
// This is a genuinely shared, cross-user library by design (see
// workspaceRoutes.js's own module comment: every authenticated user may
// read every other user's snapshots) — grouped by owner, newest snapshot
// first within each group, with the current user's own group expanded by
// default so their own past saves are immediately visible.
//
// This component owns no plotting/workspace-application logic itself —
// `onLoad(workspaceData, snapshotMeta)` is the only way it touches the
// rest of the app (App.jsx's own handleLoadWorkspaceSnapshot actually
// replaces the live workspace state). Loading another user's snapshot
// only ever copies its data into the caller's current session — this
// panel never exposes any way to rename/overwrite the ORIGINAL snapshot,
// matching the feature's own "LOAD never transfers ownership" rule.
export default function WorkspaceLibraryPanel({ isOpen, onClose, onLoad, currentUserId, isAdmin }) {
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchText, setSearchText] = useState('');
  const [expandedOwners, setExpandedOwners] = useState(() => new Set());
  const [loadingSnapshotId, setLoadingSnapshotId] = useState(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [actionError, setActionError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await workspaceCloudClient.listWorkspaceSnapshots({ limit: 200 });
      setSnapshots(res.snapshots);
      // The current user's own group starts expanded — everyone else's
      // starts collapsed (see this file's own module comment on why).
      setExpandedOwners((prev) => (prev.size > 0 ? prev : new Set([currentUserId])));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  // Deferred via setTimeout(fn, 0) — matches AdminDashboard.jsx's own fix
  // for the react-hooks/set-state-in-effect rule (see that file's own
  // comment): `refresh` sets loading state synchronously before its first
  // `await`, which the rule treats as unsafe if called directly from an
  // effect body.
  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = setTimeout(() => { refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [isOpen, refresh]);

  const groupedByOwner = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    const filtered = query
      ? snapshots.filter((s) => s.ownerDisplayName.toLowerCase().includes(query) || (s.title ?? '').toLowerCase().includes(query))
      : snapshots;
    const groups = new Map();
    for (const snap of filtered) {
      if (!groups.has(snap.ownerUserId)) groups.set(snap.ownerUserId, { ownerUserId: snap.ownerUserId, ownerDisplayName: snap.ownerDisplayName, snapshots: [] });
      groups.get(snap.ownerUserId).snapshots.push(snap);
    }
    // Each owner's own snapshots are already newest-first (the server's
    // own ORDER BY) — sort the groups themselves by their own newest
    // snapshot, so whoever saved most recently surfaces first.
    return [...groups.values()].sort((a, b) => new Date(b.snapshots[0].createdAt) - new Date(a.snapshots[0].createdAt));
  }, [snapshots, searchText]);

  const toggleOwner = (ownerUserId) => {
    setExpandedOwners((prev) => {
      const next = new Set(prev);
      if (next.has(ownerUserId)) next.delete(ownerUserId); else next.add(ownerUserId);
      return next;
    });
  };

  const formatDateTime = (iso) => new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  const handleLoad = async (snapshot) => {
    if (!window.confirm('Loading this saved workspace will replace your current workspace. Continue?')) return;
    setLoadingSnapshotId(snapshot.id);
    setActionError(null);
    try {
      const res = await workspaceCloudClient.getWorkspaceSnapshot(snapshot.id);
      onLoad(res.snapshot.workspaceData, res.snapshot);
      onClose();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setLoadingSnapshotId(null);
    }
  };

  const handleDelete = async (snapshot) => {
    if (confirmingDeleteId !== snapshot.id) {
      setConfirmingDeleteId(snapshot.id);
      return;
    }
    setDeletingId(snapshot.id);
    setActionError(null);
    try {
      await workspaceCloudClient.deleteWorkspaceSnapshot(snapshot.id);
      setSnapshots((prev) => prev.filter((s) => s.id !== snapshot.id));
    } catch (err) {
      setActionError(err.message);
    } finally {
      setDeletingId(null);
      setConfirmingDeleteId(null);
    }
  };

  if (!isOpen) return null;

  const fieldClass = 'bg-[#0b1016] border border-white/10 rounded-md px-2 py-1.5 text-xs font-mono text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/50';

  return (
    <div className="fixed inset-0 z-[84] flex items-center justify-center bg-black/55 p-4" role="presentation" onMouseDown={onClose}>
      <section
        role="dialog" aria-modal="true" aria-labelledby="workspace-library-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-3xl max-h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-xl border border-white/15 bg-[#151c24] shadow-[0_24px_80px_rgba(0,0,0,0.62)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4 shrink-0">
          <div>
            <h2 id="workspace-library-title" className="flex items-center gap-2 text-sm font-bold text-cyan-100">
              <Cloud className="h-4 w-4" /> Saved Work
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Every researcher's saved workspaces — browse, search, and load any snapshot into your current session.
            </p>
          </div>
          <button type="button" onClick={onClose} className="flex items-center justify-center rounded-md border border-white/10 bg-[#0b1016] p-1.5 text-slate-400 hover:text-red-300 hover:border-red-300/40 transition-colors" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3 shrink-0">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              className={`${fieldClass} w-full pl-7`} placeholder="Search users / saves..."
              value={searchText} onChange={(e) => setSearchText(e.target.value)}
            />
          </div>
          <button type="button" onClick={refresh} disabled={loading} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-[#0b1016] px-2 py-1.5 text-[11px] font-bold text-slate-300 hover:text-cyan-200 hover:border-cyan-300/40 transition-colors disabled:opacity-40">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
            </div>
          )}
          {actionError && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {actionError}
            </div>
          )}
          {!loading && groupedByOwner.length === 0 && !error && (
            <p className="py-6 text-center text-xs text-slate-500">No saved workspaces yet — click "Save All" to create the first one.</p>
          )}
          <div className="flex flex-col gap-2">
            {groupedByOwner.map((group) => {
              const isExpanded = expandedOwners.has(group.ownerUserId);
              return (
                <div key={group.ownerUserId} className="rounded-md border border-white/10 bg-[#0f1520]">
                  <button
                    type="button" onClick={() => toggleOwner(group.ownerUserId)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left"
                  >
                    {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-slate-400 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />}
                    <span className="text-xs font-bold text-slate-100">{group.ownerDisplayName}</span>
                    {group.ownerUserId === currentUserId && <span className="rounded bg-cyan-500/15 border border-cyan-300/30 px-1.5 py-0.5 text-[9px] font-bold text-cyan-200">You</span>}
                    <span className="ml-auto text-[10px] font-mono text-slate-500">{group.snapshots.length} save{group.snapshots.length === 1 ? '' : 's'}</span>
                  </button>
                  {isExpanded && (
                    <div className="flex flex-col gap-1.5 border-t border-white/5 px-3 py-2">
                      {group.snapshots.map((snap) => (
                        <div key={snap.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-white/5 bg-[#0b1016] px-3 py-2">
                          <div className="min-w-0">
                            {snap.title && <div className="truncate text-xs font-bold text-slate-100">{snap.title}</div>}
                            <div className="truncate text-[10px] text-slate-500">
                              {formatDateTime(snap.createdAt)} · {snap.graphCount} graph{snap.graphCount === 1 ? '' : 's'}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {(isAdmin || snap.ownerUserId === currentUserId) && (
                              <button
                                type="button" onClick={() => handleDelete(snap)} disabled={deletingId === snap.id}
                                title={confirmingDeleteId === snap.id ? 'Click again to confirm delete' : 'Delete this saved workspace'}
                                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-bold transition-colors disabled:opacity-40 ${confirmingDeleteId === snap.id ? 'border-red-300/50 bg-red-500/20 text-red-200' : 'border-white/10 bg-transparent text-slate-500 hover:text-red-300'}`}
                              >
                                {deletingId === snap.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                                {confirmingDeleteId === snap.id ? 'Confirm?' : ''}
                              </button>
                            )}
                            <button
                              type="button" onClick={() => handleLoad(snap)} disabled={loadingSnapshotId === snap.id}
                              className="flex items-center gap-1.5 rounded-md border border-cyan-300/35 bg-cyan-500/15 px-2.5 py-1 text-[11px] font-bold text-cyan-100 transition-colors hover:bg-cyan-500/25 disabled:opacity-40"
                            >
                              {loadingSnapshotId === snap.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />} Load
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
