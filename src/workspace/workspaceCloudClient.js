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

const REQUEST_TIMEOUT_MS = 8000;
// Save All's payload can be large (hundreds of graphs' worth of points) —
// a longer timeout than the general-purpose default so a big snapshot
// isn't mistaken for "the server is unreachable" mid-upload.
const SAVE_TIMEOUT_MS = 20000;

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
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }

  let responseBody = {};
  try {
    responseBody = await res.json();
  } catch {
    // A non-JSON body — fall through to the generic status-code message below.
  }

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
