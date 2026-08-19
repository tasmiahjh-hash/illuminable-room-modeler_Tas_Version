// Admin routes: the Research Admin Dashboard's entire backend surface —
// cross-user user/graph visibility, diagnostics, repair, version restore,
// soft delete/restore, metadata edit, in-app messaging, and "push a graph
// to a user." Kept in its own file for the same reason authRoutes.js is
// (see that file's own module comment) — one more growing route family
// app.js's dispatcher should try, not inline.
//
// SECURITY — this is the one thing every route below shares, and it is
// enforced here, on the server, not in the frontend (which only *hides*
// the dashboard for non-admins — see src/admin/AdminDashboard.jsx's own
// comment): `handleAdminRoute` resolves a real auth context from the
// request's own bearer token and re-checks `role === 'admin'` against a
// fresh database read (resolveAuthContext never trusts the token's own
// embedded role claim — see requireAuth.js) before touching anything below
// this comment. An authenticated-but-wrong-role request gets 403; an
// unauthenticated one gets 401. Nothing here is ever reachable by
// filters/params alone the way a non-admin's own /api/graphs* routes are
// scoped by ownerUserId — every query below is deliberately unscoped,
// because seeing across every user is the entire point of this file, and
// the role check above is what makes that safe.

import { readJsonBody, sendJson } from './httpHelpers.js';
import { resolveAuthContext } from '../auth/requireAuth.js';
import { getUserRepository } from '../repositories/userRepository.js';
import { parseListOptions, parseSearchQuery } from './queryParsing.js';

const ADMIN_PREFIX = '/api/admin/';

const graphDetails = async (repository, graphId) => {
  const graph = await repository.findById(graphId);
  if (!graph) return null;
  const geometry = await repository.getGeometry(graph.id);
  return { graph, geometry };
};

/**
 * Handles every `/api/admin/*` route. Returns true if `url`/`req.method`
 * matched (and the response has already been sent), false otherwise —
 * same contract as handleAuthRoute (see that file's own comment).
 *
 * `userRepository`/`messageRepository` are injectable, defaulting to the
 * real shared singletons, so tests exercise real HTTP round trips with no
 * database at all (mirrors handleAuthRoute's own pattern).
 */
export const handleAdminRoute = async (req, res, url, { repository, userRepository, messageRepository }) => {
  if (!url.pathname.startsWith(ADMIN_PREFIX)) return false;

  const auth = await resolveAuthContext(req, { userRepository });
  if (!auth) {
    sendJson(res, 401, { error: 'sign in required' });
    return true;
  }
  if (auth.role !== 'admin') {
    sendJson(res, 403, { error: 'admin access required' });
    return true;
  }

  // resolveAuthContext above already resolves its own copy of this same
  // fallback internally (see requireAuth.js), but every direct call below
  // (searchUsers, findById, etc.) needs its own reference — `userRepository`
  // is undefined here whenever the real server runs without an explicit
  // override (see createDefaultApp), exactly like handleAuthRoute's own
  // `repo = userRepository ?? await getUserRepository()` fallback.
  const userRepo = userRepository ?? await getUserRepository();

  const segments = url.pathname.slice(ADMIN_PREFIX.length).split('/').filter(Boolean);
  const { method } = req;

  // GET /api/admin/users[?q=...] — every account, or a free-text
  // email/displayName search, each with its own graph count + last_seen_at
  // (see userRepository.js's own touchLastSeen for what powers the
  // dashboard's "Online Status" heuristic).
  if (method === 'GET' && segments.length === 1 && segments[0] === 'users') {
    const q = url.searchParams.get('q');
    const users = q ? await userRepo.searchUsers(q) : await userRepo.listAllUsersWithGraphCounts();
    sendJson(res, 200, { users });
    return true;
  }

  // GET /api/admin/users/:userId/graphs — one user's own graph database,
  // exactly as they'd see it themselves (ownerUserId-scoped), just reached
  // from the admin's own dashboard — "Users -> select user -> View
  // Database" (see the dashboard's own step list).
  if (method === 'GET' && segments.length === 3 && segments[0] === 'users' && segments[2] === 'graphs') {
    const [, userId] = segments;
    const options = parseListOptions(url.searchParams);
    const graphs = await repository.queryGraphsAdmin({ ...options, filters: { ...options.filters, ownerUserId: userId } });
    sendJson(res, 200, { graphs });
    return true;
  }

  // POST /api/admin/users/:userId/messages { body, messageType } —
  // backs both "Message User" (messageType: 'admin_message', the default)
  // and "Push Update" (messageType: 'push_update') — the same in-app
  // inbox mechanism with a different label, per the RDS plan's own
  // confirmed "in-app inbox, not email" decision.
  if (method === 'POST' && segments.length === 3 && segments[0] === 'users' && segments[2] === 'messages') {
    const [, userId] = segments;
    const body = await readJsonBody(req);
    if (!body.body || typeof body.body !== 'string') {
      sendJson(res, 400, { error: 'body is required' });
      return true;
    }
    const message = await messageRepository.createMessage({
      userId, senderAdminId: auth.userId,
      messageType: body.messageType === 'push_update' ? 'push_update' : 'admin_message',
      body: body.body,
    });
    sendJson(res, 201, { message });
    return true;
  }

  // GET /api/admin/graphs[?...] — every graph across every owner, with the
  // same sort/filter vocabulary as the ordinary /api/graphs/search route
  // (parseListOptions/parseSearchQuery), plus owner email/display name
  // (queryGraphsAdmin's own join) and includeDeleted/onlyDeleted — the two
  // admin-only filters an ordinary request can never set, since only this
  // route ever reads them off the query string.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'graphs') {
    const query = parseSearchQuery(url.searchParams);
    const options = parseListOptions(url.searchParams);
    const filters = { ...options.filters, ...query };
    if (url.searchParams.get('includeDeleted') === 'true') filters.includeDeleted = true;
    if (url.searchParams.get('onlyDeleted') === 'true') filters.onlyDeleted = true;
    const graphs = await repository.queryGraphsAdmin({ ...options, filters });
    sendJson(res, 200, { graphs });
    return true;
  }

  // GET /api/admin/graphs/:graphId — one graph's full details (metadata +
  // current geometry) by its id — "View graph details."
  if (method === 'GET' && segments.length === 2 && segments[0] === 'graphs') {
    const [, graphId] = segments;
    const details = await graphDetails(repository, graphId);
    if (!details) {
      sendJson(res, 404, { error: 'no graph with this id' });
      return true;
    }
    sendJson(res, 200, details);
    return true;
  }

  // PATCH /api/admin/graphs/:graphId — "Edit graph metadata," admin-scoped
  // (any graph, any owner — see updateGraphMetadataAdmin's own comment).
  if (method === 'PATCH' && segments.length === 2 && segments[0] === 'graphs') {
    const [, graphId] = segments;
    const body = await readJsonBody(req);
    const updated = await repository.updateGraphMetadataAdmin(graphId, body);
    if (!updated) {
      sendJson(res, 404, { error: 'no graph with this id' });
      return true;
    }
    sendJson(res, 200, { graph: updated });
    return true;
  }

  // DELETE /api/admin/graphs/:graphId — "Delete/restore graph": soft
  // delete only (see 0008's own deleted_at comment) — never a real DELETE.
  if (method === 'DELETE' && segments.length === 2 && segments[0] === 'graphs') {
    const [, graphId] = segments;
    const deleted = await repository.softDeleteGraph(graphId);
    if (!deleted) {
      sendJson(res, 404, { error: 'no graph with this id' });
      return true;
    }
    sendJson(res, 200, { graph: deleted });
    return true;
  }

  // POST /api/admin/graphs/:graphId/restore — reverses the soft delete above.
  if (method === 'POST' && segments.length === 3 && segments[0] === 'graphs' && segments[2] === 'restore') {
    const [, graphId] = segments;
    const restored = await repository.restoreGraph(graphId);
    if (!restored) {
      sendJson(res, 404, { error: 'no graph with this id' });
      return true;
    }
    sendJson(res, 200, { graph: restored });
    return true;
  }

  // POST /api/admin/graphs/:graphId/repair — "Repair Graph": data-integrity
  // only (point_count/status reconciliation) — never a plotting/geometry
  // recompute (see repairGraph's own comment for exactly why).
  if (method === 'POST' && segments.length === 3 && segments[0] === 'graphs' && segments[2] === 'repair') {
    const [, graphId] = segments;
    const result = await repository.repairGraph(graphId, { changedByUserId: auth.userId });
    sendJson(res, 200, result);
    return true;
  }

  // GET /api/admin/graphs/:graphId/versions — version history list.
  if (method === 'GET' && segments.length === 3 && segments[0] === 'graphs' && segments[2] === 'versions') {
    const [, graphId] = segments;
    const versions = await repository.listVersions(graphId);
    sendJson(res, 200, { versions });
    return true;
  }

  // POST /api/admin/graphs/:graphId/versions/:versionNumber/restore —
  // "Restore Version."
  if (method === 'POST' && segments.length === 5 && segments[0] === 'graphs' && segments[2] === 'versions' && segments[4] === 'restore') {
    const [, graphId, , versionNumberRaw] = segments;
    const versionNumber = Number(versionNumberRaw);
    const restored = await repository.restoreVersion(graphId, versionNumber, { changedByUserId: auth.userId });
    if (!restored) {
      sendJson(res, 404, { error: 'no such graph/version' });
      return true;
    }
    sendJson(res, 200, { graph: restored });
    return true;
  }

  // POST /api/admin/graphs/:graphId/push { recipientUserId } — "Push Graph
  // to User": grants access (see pushGraphToUser's own comment on why this
  // is a grant, never a copy or ownership transfer) and, only on a genuine
  // first push (never on a no-op duplicate — see pushGraphToUser's own
  // `pushed` flag), notifies the recipient's inbox. Deliberately never
  // touches anything about the recipient's *current* open workspace —
  // this only makes the graph reachable via their own library/inbox,
  // which they open and act on explicitly (see this feature's own "do not
  // remotely overwrite whatever graph the user currently has open").
  if (method === 'POST' && segments.length === 3 && segments[0] === 'graphs' && segments[2] === 'push') {
    const [, graphId] = segments;
    const body = await readJsonBody(req);
    if (!body.recipientUserId) {
      sendJson(res, 400, { error: 'recipientUserId is required' });
      return true;
    }
    const graph = await repository.findById(graphId);
    if (!graph) {
      sendJson(res, 404, { error: 'no graph with this id' });
      return true;
    }
    const recipient = await userRepo.findById(body.recipientUserId);
    if (!recipient) {
      sendJson(res, 404, { error: 'no user with this id' });
      return true;
    }

    const result = await repository.pushGraphToUser({ graphId, recipientUserId: recipient.id, pushedByAdminId: auth.userId });
    if (result.pushed) {
      await messageRepository.createMessage({
        userId: recipient.id, senderAdminId: auth.userId, messageType: 'push_update',
        body: 'Admin sent you a graph.', relatedGraphId: graphId,
      });
    }
    sendJson(res, 200, result);
    return true;
  }

  // GET /api/admin/diagnostics/failed-jobs | corrupted-graphs | duplicate-graphs
  if (method === 'GET' && segments.length === 2 && segments[0] === 'diagnostics') {
    const [, kind] = segments;
    if (kind === 'failed-jobs') {
      sendJson(res, 200, { failedJobs: await repository.findFailedJobs() });
      return true;
    }
    if (kind === 'corrupted-graphs') {
      sendJson(res, 200, { corruptedGraphs: await repository.findCorruptedGraphs() });
      return true;
    }
    if (kind === 'duplicate-graphs') {
      sendJson(res, 200, { duplicateGraphs: await repository.findDuplicateParameterSets() });
      return true;
    }
    sendJson(res, 404, { error: 'unknown diagnostics view' });
    return true;
  }

  sendJson(res, 404, { error: 'not found' });
  return true;
};
