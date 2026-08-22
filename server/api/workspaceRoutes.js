// Workspace routes: the Cloud Workspace Library — "Save All" (create),
// "Load Saved Work" (list/get), and delete. Kept in its own file for the
// same reason authRoutes.js/adminRoutes.js are (see those files' own
// module comments) — one more route family app.js's dispatcher tries,
// not inline.
//
// Every route requires a signed-in user (resolveAuthContext) — Guests
// never reach here at all (no token, no account — see AuthGate.jsx's own
// "Guest = zero backend calls"). Unlike /api/graphs*, there is no
// ownership scoping on the two read routes: every authenticated user may
// list/load every other user's snapshots (the whole point of a shared
// library — see the feature's own "every user can view everyone's saves").
// Only the create route's ownership stamp and the delete route's
// authorization check are where "whose snapshot is this" actually matters
// — see each route's own comment.

import { readJsonBody, sendJson } from './httpHelpers.js';
import { resolveAuthContext } from '../auth/requireAuth.js';

const WORKSPACES_PREFIX = '/api/workspaces';

/**
 * Handles every `/api/workspaces*` route. Returns true if `url`/`req.method`
 * matched (and the response has already been sent), false otherwise —
 * same contract as handleAuthRoute/handleAdminRoute.
 */
export const handleWorkspaceRoute = async (req, res, url, { workspaceSnapshotRepository, userRepository }) => {
  if (url.pathname !== WORKSPACES_PREFIX && !url.pathname.startsWith(`${WORKSPACES_PREFIX}/`)) return false;

  const auth = await resolveAuthContext(req, { userRepository });
  if (!auth) {
    sendJson(res, 401, { error: 'sign in required' });
    return true;
  }

  // POST /api/workspaces { title?, workspaceData } — "Save All." Ownership
  // is stamped from the authenticated session alone, never from the
  // request body — otherwise any signed-in user could save a snapshot
  // that claims to belong to someone else. ownerDisplayName is likewise
  // the session's own current name, not anything the client supplies.
  if (req.method === 'POST' && url.pathname === WORKSPACES_PREFIX) {
    const body = await readJsonBody(req);
    if (!body.workspaceData || typeof body.workspaceData !== 'object') {
      sendJson(res, 400, { error: 'workspaceData is required' });
      return true;
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const graphCount = Array.isArray(body.workspaceData.sequences) ? body.workspaceData.sequences.length : 0;
    const snapshot = await workspaceSnapshotRepository.createSnapshot({
      ownerUserId: auth.userId,
      ownerDisplayName: auth.displayName || auth.email,
      title,
      workspaceData: body.workspaceData,
      graphCount,
    });
    sendJson(res, 201, { snapshot });
    return true;
  }

  // GET /api/workspaces[?q=&limit=&offset=] — the library's own browse
  // list. Metadata only (see workspaceSnapshotRepository.js's own
  // listSnapshots comment on why workspace_data is never included here) —
  // a Load selects one specific snapshot by id (below) to get the full
  // payload, exactly once, only for the snapshot actually being loaded.
  if (req.method === 'GET' && url.pathname === WORKSPACES_PREFIX) {
    const search = url.searchParams.get('q') || undefined;
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
    const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined;
    const snapshots = await workspaceSnapshotRepository.listSnapshots({ search, limit, offset });
    sendJson(res, 200, { snapshots });
    return true;
  }

  // GET /api/workspaces/:id — the one full payload a Load needs. Readable
  // by any authenticated user regardless of ownership (see this file's
  // own module comment) — this is a shared library by design.
  if (req.method === 'GET' && url.pathname.startsWith(`${WORKSPACES_PREFIX}/`)) {
    const id = decodeURIComponent(url.pathname.slice(`${WORKSPACES_PREFIX}/`.length));
    if (!id) {
      sendJson(res, 400, { error: 'missing id' });
      return true;
    }
    const snapshot = await workspaceSnapshotRepository.getSnapshotById(id);
    if (!snapshot) {
      sendJson(res, 404, { error: 'no snapshot with this id' });
      return true;
    }
    sendJson(res, 200, { snapshot });
    return true;
  }

  // DELETE /api/workspaces/:id — "manage/delete your OWN snapshots"; an
  // admin may delete any snapshot (mirrors adminRoutes.js's own "admin
  // bypasses ownership" precedent), a research_user only their own.
  // Loading someone else's snapshot never grants any delete/overwrite
  // permission over it — see this feature's own "LOAD = copy... never
  // transfers ownership" rule; this check is what actually enforces that.
  if (req.method === 'DELETE' && url.pathname.startsWith(`${WORKSPACES_PREFIX}/`)) {
    const id = decodeURIComponent(url.pathname.slice(`${WORKSPACES_PREFIX}/`.length));
    if (!id) {
      sendJson(res, 400, { error: 'missing id' });
      return true;
    }
    const snapshot = await workspaceSnapshotRepository.getSnapshotById(id);
    if (!snapshot) {
      sendJson(res, 404, { error: 'no snapshot with this id' });
      return true;
    }
    if (auth.role !== 'admin' && snapshot.ownerUserId !== auth.userId) {
      sendJson(res, 403, { error: "you don't own this snapshot" });
      return true;
    }
    await workspaceSnapshotRepository.deleteSnapshot(id);
    sendJson(res, 200, { deleted: true });
    return true;
  }

  sendJson(res, 404, { error: 'not found' });
  return true;
};
