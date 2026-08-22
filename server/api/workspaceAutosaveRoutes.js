// Cloud Autosave routes: ONE continuously-updated "current workspace" per
// account — see workspaceAutosaveRepository.js's own module comment for
// how this differs from workspaceRoutes.js's own Save All/Load Saved Work
// (many immutable, dated, shared snapshots). This is deliberately
// private: unlike workspace_snapshots (any authenticated user may read
// any other user's), an autosave is never readable by anyone but its own
// owner — it's a resume-where-you-left-off convenience, not something to
// share.
//
// Kept in its own file for the same reason authRoutes.js/adminRoutes.js/
// workspaceRoutes.js are (see those files' own module comments).

import { readJsonBody, sendJson } from './httpHelpers.js';
import { resolveAuthContext } from '../auth/requireAuth.js';

const AUTOSAVE_PATH = '/api/workspace-autosave';

/**
 * Handles GET/PUT `/api/workspace-autosave`. Returns true if `url`/
 * `req.method` matched (and the response has already been sent), false
 * otherwise — same contract as handleAuthRoute/handleAdminRoute/
 * handleWorkspaceRoute.
 */
export const handleWorkspaceAutosaveRoute = async (req, res, url, { workspaceAutosaveRepository, userRepository }) => {
  if (url.pathname !== AUTOSAVE_PATH) return false;

  const auth = await resolveAuthContext(req, { userRepository });
  if (!auth) {
    sendJson(res, 401, { error: 'sign in required' });
    return true;
  }

  // GET: the caller's own autosave only — always scoped to auth.userId,
  // never a path/query param, so this can never become a way to read
  // another user's in-progress work (unlike the shared Save All library,
  // this is never meant to be readable by anyone else).
  if (req.method === 'GET') {
    const autosave = await workspaceAutosaveRepository.getAutosave(auth.userId);
    sendJson(res, 200, { autosave });
    return true;
  }

  // PUT { workspaceData, clientRevision } — the debounced autosave write
  // itself. ownerUserId is always the authenticated session's own id,
  // never trusted from the request body (mirrors workspaceRoutes.js's own
  // POST /api/workspaces rule). clientRevision is what lets the
  // repository's own conditional UPSERT reject a stale/out-of-order write
  // — see upsertAutosave's own comment. `applied: false` is a normal,
  // non-error outcome (200, not 409): the caller already has the more
  // recent state, which is exactly the "an older request never overwrites
  // a newer one" requirement working as intended, not a failure to report.
  if (req.method === 'PUT') {
    const body = await readJsonBody(req);
    if (!body.workspaceData || typeof body.workspaceData !== 'object') {
      sendJson(res, 400, { error: 'workspaceData is required' });
      return true;
    }
    const clientRevision = Number(body.clientRevision);
    if (!Number.isFinite(clientRevision) || clientRevision < 0) {
      sendJson(res, 400, { error: 'a non-negative clientRevision is required' });
      return true;
    }
    const result = await workspaceAutosaveRepository.upsertAutosave({
      ownerUserId: auth.userId, workspaceData: body.workspaceData, clientRevision,
    });
    sendJson(res, 200, result);
    return true;
  }

  sendJson(res, 404, { error: 'not found' });
  return true;
};
