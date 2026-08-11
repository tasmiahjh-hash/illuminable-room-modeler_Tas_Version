// Auth state for the whole app — one hook, owned by main.jsx's AuthGate,
// threaded down to App.jsx as a plain prop (see AuthGate.jsx) rather than
// context, matching this project's existing style of passing state down
// explicitly instead of introducing a provider tree (App.jsx has none
// today).

import { useState, useEffect, useCallback } from 'react';
import * as authClient from './authClient.js';

export const AUTH_STATUS = {
  // Checking a stored token against the server on first mount — nothing
  // should render the Login screen or the app shell yet.
  CHECKING: 'checking',
  // No valid session and no choice made yet — show the Login screen.
  UNSET: 'unset',
  // Explicitly chose "Continue as Guest" — temporary, local-only,
  // narrowed access (see App.jsx's own guest-mode gating).
  GUEST: 'guest',
  SIGNED_IN: 'signedIn',
};

export const useAuth = () => {
  // The synchronous half of "is there a stored token" (no stored token at
  // all) is decided right here, in the initializer, not as a setState
  // inside the effect below — only the async half (verifying a token that
  // *does* exist against the server) genuinely needs an effect.
  const [status, setStatus] = useState(() => (authClient.getStoredToken() ? AUTH_STATUS.CHECKING : AUTH_STATUS.UNSET));
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [error, setError] = useState(null);

  // On mount only: a stored ("stay signed in") token is re-validated
  // against the server rather than trusted blindly — it may have expired,
  // or been revoked by a logout on another device (see tokens.js's own
  // token_version comment) since it was stored.
  useEffect(() => {
    const stored = authClient.getStoredToken();
    if (!stored) return undefined; // already AUTH_STATUS.UNSET from the initializer above.
    let cancelled = false;
    authClient.fetchMe(stored)
      .then((body) => {
        if (cancelled) return;
        setUser(body.user);
        setToken(stored);
        setStatus(AUTH_STATUS.SIGNED_IN);
      })
      .catch(() => {
        if (cancelled) return;
        authClient.setStoredToken(null);
        setStatus(AUTH_STATUS.UNSET);
      });
    return () => { cancelled = true; };
  }, []);

  const signIn = useCallback(async ({ email, password }) => {
    setError(null);
    try {
      const body = await authClient.login({ email, password });
      authClient.setStoredToken(body.token);
      setToken(body.token);
      setUser(body.user);
      setStatus(AUTH_STATUS.SIGNED_IN);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }, []);

  const signUp = useCallback(async ({ email, password, displayName }) => {
    setError(null);
    try {
      const body = await authClient.signup({ email, password, displayName });
      authClient.setStoredToken(body.token);
      setToken(body.token);
      setUser(body.user);
      setStatus(AUTH_STATUS.SIGNED_IN);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }, []);

  // Not persisted anywhere on purpose — reloading always returns to the
  // Login screen rather than silently re-entering Guest mode, matching
  // "Guest data is temporary" in spirit as well as in storage.
  const continueAsGuest = useCallback(() => {
    setError(null);
    setUser(null);
    setToken(null);
    setStatus(AUTH_STATUS.GUEST);
  }, []);

  const signOut = useCallback(async () => {
    if (token) {
      try {
        await authClient.logout(token);
      } catch {
        // Best-effort — the local session is cleared below regardless, so
        // a signed-out user is never stuck unable to leave their account
        // just because the logout request itself failed to reach the
        // server (e.g. offline).
      }
    }
    authClient.setStoredToken(null);
    setUser(null);
    setToken(null);
    setError(null);
    setStatus(AUTH_STATUS.UNSET);
  }, [token]);

  return {
    status, user, token, error,
    role: user?.role ?? null,
    signIn, signUp, continueAsGuest, signOut,
  };
};
