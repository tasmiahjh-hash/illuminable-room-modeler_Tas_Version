// Browser client for server/api/authRoutes.js — the only module that talks
// to /api/auth/*. Mirrors src/anglePlot/remoteGraphRepository.js's own
// shared fetch helpers (apiClientUtils.js), but with the opposite failure
// philosophy: that file treats every failure as "the optional shared cache
// isn't available, fall back silently," which is correct for a nice-to-
// have. Auth is not optional — a failed signup/login must surface a real,
// readable error to the user, never fail silently into some default state.

import { apiBaseUrl, fetchWithTimeout } from '../anglePlot/apiClientUtils.js';

// Signup/login are deliberate, user-initiated actions the user is actively
// waiting on (not a background render-path optimization racing an instant
// local fallback), so this can afford to wait longer than
// remoteGraphRepository.js's aggressive 600ms before giving up.
const AUTH_TIMEOUT_MS = 8000;

const TOKEN_STORAGE_KEY = 'illuminable-auth-token';

// "Stay signed in" (the confirmed decision) means the token belongs in
// localStorage, not sessionStorage — it must survive closing the tab.
// Wrapped in try/catch: some environments (private browsing in certain
// browsers, storage disabled by policy) throw on any localStorage access
// at all, and losing "stay signed in" gracefully is far better than the
// whole app crashing over it.
export const getStoredToken = () => {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
};

export const setStoredToken = (token) => {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable — the session simply won't persist across a
    // reload; every call site already re-checks auth state on mount, so
    // this degrades to "signed out after refresh," never a crash.
  }
};

const request = async (path, { method = 'GET', body, token } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetchWithTimeout(
      `${apiBaseUrl()}${path}`,
      { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
      AUTH_TIMEOUT_MS,
    );
  } catch {
    // Covers connection refused, DNS failure, and this function's own
    // timeout abort alike — none of these have a more specific message
    // worth surfacing than "couldn't reach the server."
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }

  let responseBody = {};
  try {
    responseBody = await res.json();
  } catch {
    // A non-JSON body (e.g. a proxy's own HTML error page) — fall through
    // to the generic status-code message below.
  }

  if (!res.ok) throw new Error(responseBody.error || `Request failed (${res.status})`);
  return responseBody;
};

/** @returns {Promise<{token: string, user: object}>} throws on any failure, with a message safe to show the user directly. */
export const signup = ({ email, password, displayName }) => request('/api/auth/signup', { method: 'POST', body: { email, password, displayName } });

/** @returns {Promise<{token: string, user: object}>} throws on any failure. */
export const login = ({ email, password }) => request('/api/auth/login', { method: 'POST', body: { email, password } });

/** Best-effort — the caller still clears its own local token/state regardless of whether this succeeds (see useAuth's own signOut). */
export const logout = (token) => request('/api/auth/logout', { method: 'POST', token });

/** @returns {Promise<{user: object}>} throws (including a 401 for an invalid/expired/revoked token) so the caller can distinguish "definitely signed out" from a transient network failure if it ever needs to. */
export const fetchMe = (token) => request('/api/auth/me', { token });
