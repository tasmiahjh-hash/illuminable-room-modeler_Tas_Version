// Browser client for server/api/adminRoutes.js — the only module that
// talks to /api/admin/* and /api/messages. Mirrors src/auth/authClient.js's
// own request/error-handling shape exactly (see that file's own comment):
// every admin action is a deliberate, user-initiated click an admin is
// actively waiting on, so failures surface as a real, readable error
// rather than failing silently.
//
// SECURITY NOTE: this file (and the "Research Admin Dashboard" button that
// renders AdminDashboard.jsx) is a convenience — hiding the button from a
// non-admin is not what makes this safe. Every route it calls re-checks
// role === 'admin' against a fresh database read on the server (see
// adminRoutes.js's own module comment) and returns 401/403 regardless of
// what the frontend shows or hides.

import { apiBaseUrl, fetchWithTimeout } from '../anglePlot/apiClientUtils.js';
import { getStoredToken } from '../auth/authClient.js';

const REQUEST_TIMEOUT_MS = 8000;

const request = async (path, { method = 'GET', body } = {}) => {
  const token = getStoredToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetchWithTimeout(
      `${apiBaseUrl()}${path}`,
      { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
      REQUEST_TIMEOUT_MS,
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

const qs = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

// --- Users -------------------------------------------------------------

/** @returns {Promise<{users: object[]}>} every account (or a `q` email/displayName search), each with graphCount + lastSeenAt. */
export const listUsers = (q) => request(`/api/admin/users${qs({ q })}`);

/** @returns {Promise<{graphs: object[]}>} one user's own graph database, exactly as they'd see it themselves. */
export const listUserGraphs = (userId, options = {}) => request(`/api/admin/users/${encodeURIComponent(userId)}/graphs${qs(options)}`);

/** Sends an in-app inbox message — `messageType` is 'admin_message' (Message User) or 'push_update' (Push Update). */
export const messageUser = (userId, body, messageType = 'admin_message') => request(`/api/admin/users/${encodeURIComponent(userId)}/messages`, { method: 'POST', body: { body, messageType } });

// --- Graphs --------------------------------------------------------------

/** @returns {Promise<{graphs: object[]}>} every graph across every owner, with owner email/display name. */
export const listAllGraphs = (options = {}) => request(`/api/admin/graphs${qs(options)}`);

/** @returns {Promise<{graph, geometry}>} one graph's full details by id. */
export const getGraphDetails = (graphId) => request(`/api/admin/graphs/${encodeURIComponent(graphId)}`);

export const updateGraphMetadata = (graphId, updates) => request(`/api/admin/graphs/${encodeURIComponent(graphId)}`, { method: 'PATCH', body: updates });

export const deleteGraph = (graphId) => request(`/api/admin/graphs/${encodeURIComponent(graphId)}`, { method: 'DELETE' });

export const restoreGraph = (graphId) => request(`/api/admin/graphs/${encodeURIComponent(graphId)}/restore`, { method: 'POST' });

/** Data-integrity-only repair (point_count/status reconciliation) — never a plotting/geometry recompute. */
export const repairGraph = (graphId) => request(`/api/admin/graphs/${encodeURIComponent(graphId)}/repair`, { method: 'POST' });

export const listGraphVersions = (graphId) => request(`/api/admin/graphs/${encodeURIComponent(graphId)}/versions`);

export const restoreGraphVersion = (graphId, versionNumber) => request(`/api/admin/graphs/${encodeURIComponent(graphId)}/versions/${versionNumber}/restore`, { method: 'POST' });

/** Grants `recipientUserId` access to this graph and (on a genuine first push) notifies their inbox — see pushGraphToUser's own server-side comment on why this is a grant, never a copy. */
export const pushGraphToUser = (graphId, recipientUserId) => request(`/api/admin/graphs/${encodeURIComponent(graphId)}/push`, { method: 'POST', body: { recipientUserId } });

// --- Diagnostics -----------------------------------------------------------

export const listFailedJobs = () => request('/api/admin/diagnostics/failed-jobs');
export const listCorruptedGraphs = () => request('/api/admin/diagnostics/corrupted-graphs');
export const listDuplicateGraphs = () => request('/api/admin/diagnostics/duplicate-graphs');

// --- A signed-in user's own inbox (not admin-only — any authenticated user) -

/** @returns {Promise<{messages: object[]}>} the caller's own inbox, newest first. */
export const listMyMessages = () => request('/api/messages');

export const markMessageRead = (id) => request(`/api/messages/${encodeURIComponent(id)}/read`, { method: 'PATCH' });

/** @returns {Promise<{exists, graph, geometry}>} one graph's full geometry by id — scoped server-side to graphs the caller owns or was pushed (see app.js's own GET /api/graphs/by-id/:graphId comment). Backs the inbox's "Load Graph" button. */
export const loadGraphById = (graphId) => request(`/api/graphs/by-id/${encodeURIComponent(graphId)}`);
