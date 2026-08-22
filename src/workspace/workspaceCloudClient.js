// Browser client for server/api/workspaceRoutes.js — the Cloud Workspace
// Library ("Save All" / "Load Saved Work"). Mirrors src/auth/authClient.js's
// own request/error-handling shape (see that file's own comment) and
// src/admin/adminClient.js's own Authorization-header pattern: every call
// here is a deliberate, user-initiated action (clicking Save All, opening
// the library, clicking Load), so a failure surfaces as a real, readable
// error rather than failing silently the way the background auto-save
// (remoteGraphRepository.js's uploadRemoteExactGraph) intentionally does.

import { apiBaseUrl, fetchWithTimeout } from '../anglePlot/apiClientUtils.js';
import { getStoredToken } from '../auth/authClient.js';

// Render's free tier sleeps a backend after ~15 minutes idle and can take
// up to ~60s to wake on the next request (see DEPLOYMENT.md's own note on
// this) — a short, plotting-style timeout here would misreport that
// entirely normal wake-up delay as "the server is down" on what's very
// often literally the first authenticated request of a session (opening
// this library). Long enough to survive a cold start; still bounded so a
// genuinely dead backend doesn't hang the UI forever.
const REQUEST_TIMEOUT_MS = 45000;
// Save All's payload can be large (hundreds of graphs' worth of points) —
// on top of the same cold-start allowance above.
const SAVE_TIMEOUT_MS = 60000;

const request = async (path, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) => {
  const token = getStoredToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetchWithTimeout(
      `${apiBaseUrl()}${path}`,
      { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
      timeoutMs,
    );
  } catch {
    // Covers connection refused, DNS failure, a CORS-blocked request, and
    // this function's own timeout abort alike — fetch() can't distinguish
    // them, so neither can this message. Explicitly mentions the cold-start
    // possibility (see REQUEST_TIMEOUT_MS's own comment) since that's the
    // single most common real cause here, not a genuine outage.
    throw new Error("Couldn't reach the server. It may be waking up after being idle (this can take up to a minute on Render's free tier) — please try again in a moment.");
  }

  let responseBody = {};
  try {
    responseBody = await res.json();
  } catch {
    // A non-JSON body — fall through to the generic status-code message below.
  }

  // Distinguishes the failure classes this feature's own spec asks for
  // (never lump a stale/expired session or a permissions error in with
  // "can't reach the server" — those need a different fix from the user's
  // side than "wait and retry").
  if (res.status === 401) throw new Error('Your session has expired — please sign in again.');
  if (res.status === 403) throw new Error(responseBody.error || "You don't have permission to do that.");
  if (res.status >= 500) throw new Error(responseBody.error || 'The server hit an error. Please try again.');
  if (!res.ok) throw new Error(responseBody.error || `Request failed (${res.status})`);
  return responseBody;
};

/**
 * "Save All": persists `workspaceData` (App.jsx's own buildWorkspaceSnapshot
 * output — the exact same shape local autosave already uses) as one new,
 * immutable, dated snapshot owned by the caller's own signed-in account.
 * `title` is optional — pass '' or omit it entirely for a date-only save.
 * @returns {Promise<{snapshot: object}>} the created snapshot's metadata (no workspaceData echoed back).
 */
export const createWorkspaceSnapshot = ({ title, workspaceData }) => request('/api/workspaces', {
  method: 'POST', body: { title, workspaceData }, timeoutMs: SAVE_TIMEOUT_MS,
});

/**
 * "Load Saved Work"'s own browse list — every user's snapshots, metadata
 * only (never the full workspaceData — see server/repositories/
 * workspaceSnapshotRepository.js's own comment on why a browse list must
 * never ship every user's potentially-huge saved payload).
 * @param {{q?: string, limit?: number, offset?: number}} [options]
 * @returns {Promise<{snapshots: object[]}>}
 */
export const listWorkspaceSnapshots = ({ q, limit, offset } = {}) => {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (limit !== undefined) params.set('limit', String(limit));
  if (offset !== undefined) params.set('offset', String(offset));
  const query = params.toString();
  return request(`/api/workspaces${query ? `?${query}` : ''}`);
};

/** One full snapshot (including workspaceData) — fetched only when a specific snapshot is actually being loaded. @returns {Promise<{snapshot: object}>} */
export const getWorkspaceSnapshot = (id) => request(`/api/workspaces/${encodeURIComponent(id)}`);

/** Deletes a snapshot — the caller's own, or any snapshot if the caller is an admin (enforced server-side, see workspaceRoutes.js). */
export const deleteWorkspaceSnapshot = (id) => request(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
