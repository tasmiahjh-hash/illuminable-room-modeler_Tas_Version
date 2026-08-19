import { useEffect, useState, useCallback } from 'react';
import { Bell, X, Loader2, FolderOpen } from 'lucide-react';
import * as adminClient from '../admin/adminClient.js';

// InboxBell: a signed-in user's own in-app inbox (see
// messageRepository.js's own module comment — this is what "Message User"/
// "Push Update" from the Research Admin Dashboard actually delivers to).
// Available to any signed-in Research User or Admin — never rendered for
// a Guest (see App.jsx's own `!isGuest` gate), since Guests have no
// account/database for a message to be about in the first place.
//
// "Load Graph" hands the downloaded {graph, geometry} to `onLoadGraph`
// (App.jsx's handleLoadGraphFromLibrary — the exact same handler the
// Graph Library panel already uses) so a pushed graph opens into a *new*
// row, never replacing whatever the user currently has open (see the
// "do not remotely overwrite whatever graph the user currently has open"
// requirement this inbox exists to satisfy).
export default function InboxBell({ onLoadGraph }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loadingGraphId, setLoadingGraphId] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminClient.listMyMessages();
      setMessages(res.messages);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Deferred via setTimeout(fn, 0) — matches the identical fix used
  // throughout this codebase (see useGraphLibrary.js/AdminDashboard.jsx's
  // own comment) for the react-hooks/set-state-in-effect rule: `refresh`
  // sets loading state synchronously before its first `await`, which the
  // rule treats as "setState synchronously within an effect" if called
  // directly from the effect body.
  useEffect(() => {
    const timer = setTimeout(() => { refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  const unreadCount = messages.filter((m) => !m.readAt).length;

  const handleLoadGraph = async (message) => {
    setLoadingGraphId(message.relatedGraphId);
    try {
      const res = await adminClient.loadGraphById(message.relatedGraphId);
      if (res.exists) onLoadGraph(res.graph, res.geometry);
      if (!message.readAt) {
        await adminClient.markMessageRead(message.id);
        setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, readAt: new Date().toISOString() } : m)));
      }
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingGraphId(null);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Messages"
        className="relative flex items-center justify-center rounded-md border border-white/10 bg-[#0b1016] p-1.5 text-slate-400 hover:text-cyan-200 hover:border-cyan-300/40 transition-colors"
      >
        <Bell className="h-3.5 w-3.5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-400 px-0.5 text-[9px] font-black text-black">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-[93] mt-1.5 w-72 rounded-lg border border-white/15 bg-[#151c24] shadow-[0_16px_48px_rgba(0,0,0,0.5)]">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
            <span className="text-[11px] font-bold text-slate-200">Messages</span>
            <button type="button" onClick={() => setOpen(false)} className="text-slate-500 hover:text-red-300"><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="max-h-80 overflow-y-auto p-2">
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
            {error && <p className="px-1 text-[11px] text-red-300">{error}</p>}
            {!loading && messages.length === 0 && <p className="px-1 py-2 text-[11px] text-slate-500">No messages.</p>}
            <div className="flex flex-col gap-1.5">
              {messages.map((m) => (
                <div key={m.id} className={`rounded-md border px-2.5 py-2 text-[11px] ${m.readAt ? 'border-white/5 bg-[#0f1520] text-slate-400' : 'border-cyan-300/25 bg-cyan-500/5 text-slate-200'}`}>
                  <p>{m.body}</p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-slate-500">{new Date(m.createdAt).toLocaleString()}</span>
                    {m.relatedGraphId && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-cyan-300/30 px-1.5 py-0.5 text-[10px] font-bold text-cyan-200 hover:border-cyan-300/60 disabled:opacity-40"
                        disabled={loadingGraphId === m.relatedGraphId}
                        onClick={() => handleLoadGraph(m)}
                      >
                        {loadingGraphId === m.relatedGraphId ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />} Load Graph
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
