import { useState, useEffect } from 'react';
import { useAuth, AUTH_STATUS } from './useAuth.js';
import LoginScreen from './LoginScreen.jsx';
import App from '../App.jsx';
import { fetchCloudAutosave } from '../workspace/workspaceAutosaveClient.js';

// The app's single entry-point gate: owns the one useAuth() call for the
// whole tree (see useAuth.js's own comment on why this is a plain prop,
// not context) and decides Login screen vs. the app shell. Kept as its own
// tiny component (not inlined in main.jsx) so it's independently testable/
// readable rather than mixed into the root-render bootstrap.
//
// Cloud Autosave's own "restore before first paint" gate lives here too:
// for a signed-in (non-Guest) user, this fetches their one account-wide
// autosave and holds off mounting App until it resolves, rather than
// mounting App immediately and replacing its state afterward. This is
// what lets every existing `useState(() => restoredWorkspace?.x ?? default)`
// initializer in App.jsx keep working completely unchanged — App.jsx
// itself doesn't know or care whether `restoredWorkspace` came from the
// cloud or from localStorage, only that it's already resolved by the time
// App's very first render runs (React's own synchronous-initializer
// guarantee). See App.jsx's own initialCloudWorkspace prop for the other
// half of this.
const AuthGate = () => {
  const auth = useAuth();
  const signedInUserId = auth.status === AUTH_STATUS.SIGNED_IN ? auth.user?.id : null;

  // Three distinct states, deliberately using JS's own null/undefined
  // duality rather than a separate flag — see App.jsx's own
  // initialCloudWorkspace comment for exactly how each one is handled:
  //   undefined     — not applicable (Guest) or the fetch itself failed
  //                   (offline/server down) → App.jsx falls back to its
  //                   existing localStorage-only behavior, unchanged.
  //   null          — the fetch succeeded and confirmed: this account has
  //                   never cloud-autosaved anything yet → start blank,
  //                   specifically NOT localStorage (which could hold
  //                   some other account's or Guest's leftover local data).
  //   {workspaceData, clientRevision} — the fetch succeeded and found a
  //                   real autosave to restore. clientRevision travels
  //                   with it (not just workspaceData) so App.jsx's own
  //                   local revision counter can continue from where this
  //                   account's last save left off, rather than
  //                   restarting at 0 — restarting would make this
  //                   session's very first new save get rejected as
  //                   stale by the server's own conditional UPSERT.
  const [cloudWorkspace, setCloudWorkspace] = useState(undefined);
  // Guests need no fetch at all (see the effect's own early branch) —
  // starts false only so a genuinely signed-in session's very first
  // render (before the effect below has had a chance to run) doesn't
  // briefly flash App with an unresolved cloudWorkspace.
  const [cloudWorkspaceReady, setCloudWorkspaceReady] = useState(false);

  // Deferred via setTimeout(fn, 0) — not a debounce, but so this effect
  // never calls setState synchronously within the effect body itself
  // (matches AdminDashboard.jsx/WorkspaceLibraryPanel.jsx/InboxBell.jsx's
  // own identical fix for the same react-hooks/set-state-in-effect rule).
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      if (!signedInUserId) {
        // Not signed in — Guests skip the fetch entirely (zero backend
        // calls, per App.jsx's own isGuest gating elsewhere), and a
        // just-signed-out session resets this so a *different* account
        // signing in next never inherits a stale fetch meant for someone
        // else (see this file's own "never mix work between accounts" goal).
        setCloudWorkspace(undefined);
        setCloudWorkspaceReady(auth.status === AUTH_STATUS.GUEST);
        return;
      }
      setCloudWorkspaceReady(false);
      fetchCloudAutosave()
        .then((res) => {
          if (cancelled) return;
          setCloudWorkspace(res.autosave ? { workspaceData: res.autosave.workspaceData, clientRevision: res.autosave.clientRevision } : null);
          setCloudWorkspaceReady(true);
        })
        .catch(() => {
          // Offline/unreachable — fall back to whatever's in localStorage
          // (App.jsx's own restoredWorkspace initializer already does this
          // when initialCloudWorkspace is undefined) rather than blocking
          // the app forever on one failed network request.
          if (cancelled) return;
          setCloudWorkspace(undefined);
          setCloudWorkspaceReady(true);
        });
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [signedInUserId, auth.status]);

  if (auth.status === AUTH_STATUS.CHECKING) {
    // A stored ("stay signed in") token is being re-validated against the
    // server — see useAuth's own mount effect. Deliberately minimal: this
    // is usually on-screen for well under a second.
    return (
      <div className="app-theme app-theme-light min-h-screen w-full flex items-center justify-center bg-[#080b0f] text-slate-500 text-sm">
        Loading…
      </div>
    );
  }

  if (auth.status === AUTH_STATUS.UNSET) {
    return <LoginScreen auth={auth} />;
  }

  if (auth.status === AUTH_STATUS.SIGNED_IN && !cloudWorkspaceReady) {
    return (
      <div className="app-theme app-theme-light min-h-screen w-full flex items-center justify-center bg-[#080b0f] text-slate-500 text-sm">
        Restoring your workspace…
      </div>
    );
  }

  return <App auth={auth} initialCloudWorkspace={cloudWorkspace} />;
};

export default AuthGate;
