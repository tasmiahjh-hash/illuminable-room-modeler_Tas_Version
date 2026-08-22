// Browser client for server/api/workspaceAutosaveRoutes.js — Cloud
// Autosave: the ONE continuously-updated "current workspace" for the
// signed-in account, distinct from workspaceCloudClient.js's own Save
// All/Load Saved Work (many immutable, dated, shared snapshots). Mirrors
// that file's own request/error-handling shape.

import { apiBaseUrl, fetchWithTimeout } from '../anglePlot/apiClientUtils.js';
import { getStoredToken } from '../auth/authClient.js';

// Long enough to survive Render's free-tier cold start (up to ~60s after
// idling — see DEPLOYMENT.md, and workspaceCloudClient.js's own identical
// comment/fix) — a short timeout here would misreport that normal wake-up
// delay as "the server is down" on what's very often the very first
// authenticated request of a session (restoring on login).
const TIMEOUT_MS = 45000;

const request = async (path, { method = 'GET', body, timeoutMs = TIMEOUT_MS } = {}) => {
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
    throw new Error("Couldn't reach the server. It may be waking up after being idle (this can take up to a minute on Render's free tier) — please try again in a moment.");
  }

  let responseBody = {};
  try {
    responseBody = await res.json();
  } catch {
    // A non-JSON body — fall through to the generic status-code message below.
  }

  if (res.status === 401) throw new Error('Your session has expired — please sign in again.');
  if (res.status >= 500) throw new Error(responseBody.error || 'The server hit an error. Please try again.');
  if (!res.ok) throw new Error(responseBody.error || `Request failed (${res.status})`);
  return responseBody;
};

/**
 * Fetches the signed-in account's own current cloud autosave — the
 * authoritative "resume where I left off" state, restorable on any
 * device/browser (see AuthGate.jsx's own pre-fetch-before-mount comment
 * for why this must resolve before the app renders, not after).
 * @returns {Promise<{autosave: {workspaceData, clientRevision, updatedAt}|null}>}
 */
export const fetchCloudAutosave = () => request('/api/workspace-autosave');

/**
 * Upserts the account's one autosave row. `clientRevision` must be a
 * monotonically increasing counter *this browser tab* maintains (see
 * App.jsx's own cloudAutosaveRevisionRef) — the server's own conditional
 * UPSERT (workspaceAutosaveRepository.js) uses it to reject a write whose
 * revision is lower than what's already stored, so an older, out-of-order
 * request (e.g. two debounced saves resolving out of send-order) can never
 * clobber a newer one.
 * @returns {Promise<{applied: boolean, autosave: object|null}>} `applied: false`
 *   is a normal outcome (this write lost the race, not an error) — see
 *   that field's own comment in the repository.
 */
export const saveCloudAutosave = (workspaceData, clientRevision) => request('/api/workspace-autosave', {
  method: 'PUT', body: { workspaceData, clientRevision },
});
