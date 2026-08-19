// The thin HTTP layer between the browser app and GraphRepository (Phase
// 5's own "GraphRepository.graphExists / download / upload" pipeline, now
// joined by Phase 6's shared-library browse/search/sort/filter routes). A
// browser tab cannot open a raw Postgres connection — this is the piece
// that makes "the browser asks PostgreSQL" actually possible: the browser
// calls these routes (see src/anglePlot/remoteGraphRepository.js for the
// download/upload pipeline's own client — Phase 6 is backend-only, so
// nothing in src/** calls the new browse/search routes yet), this file
// calls GraphRepository, and GraphRepository is the only thing that ever
// touches SQL. Nothing here builds a query itself — see queryParsing.js
// for the (non-SQL) query-string parsing that keeps these handlers thin.
//
// Deliberately plain Node `http`, no framework: a handful of routes don't
// need one, and it keeps this server free of a dependency this project
// otherwise has no use for.
//
// Route table (order matters — see the handler below)
// -------------------------------------------------------
//   GET  /health                 liveness check for the hosting platform (Render)
//   POST /api/auth/*             signup/login/logout/me — see authRoutes.js
//   /api/admin/*                 Research Admin Dashboard — see adminRoutes.js (role === 'admin' only)
//   GET   /api/messages          the caller's own in-app inbox
//   PATCH /api/messages/:id/read marks one of the caller's own inbox messages read
//   GET  /api/graphs             listGraphs      (browse/filter/sort, metadata only)
//   GET  /api/graphs/search      searchGraphs    (hash/code/angle/length search, metadata only)
//   GET  /api/graphs/recent      listRecentGraphs (metadata only)
//   GET  /api/graphs/by-id/:id   download by graph id (backs the inbox's "Load Graph" — see adminClient.js)
//   GET  /api/graphs/:hash       getGraphWithGeometry (download — the one route that returns geometry)
//   POST /api/graphs             uploadExactGraphIfMissing
//   GET    /api/local-graphs        graphDatabase.listGraphs    (browse/sort, metadata only)
//   GET    /api/local-graphs/search graphDatabase.searchGraphs  (q=free text across title/code/tags/notes/owner/hash, plus exact-field filters — metadata only)
//   GET    /api/local-graphs/:hash  graphDatabase.loadGraph     (file-based local GraphDatabase — permanent cache; the one route that returns points)
//   POST   /api/local-graphs        graphDatabase.saveGraph
//   PATCH  /api/local-graphs/:hash  graphDatabase.updateGraphMetadata (rename/favorite/tags/notes/visibility/color — never points)
//   DELETE /api/local-graphs/:hash  graphDatabase.deleteGraph
// The three metadata-only routes are matched before the generic
// `/api/graphs/:hash` fallback specifically so a hash can never collide
// with a literal path segment like "search" or "recent" (a real hash is a
// long, structured string that URL-encodes distinctly from either); the
// same reasoning is why GET /api/local-graphs/search is checked before the
// generic GET /api/local-graphs/:hash fallback below.
//
// /api/local-graphs is a distinct prefix, not a variant of /api/graphs, so
// it can never collide with the PostgreSQL-backed routes above — it talks
// to a completely separate storage system (the file-based GraphDatabase,
// server/graphDatabase/graphDatabase.js) used both as this app's permanent
// local render cache (see AnglePlotWindow.jsx's STEP 2b/STEP 4) and,
// starting with the Graph Database browser (src/graphLibrary/**), as a
// full local library with search/sort/rename/delete/favorite/tags/notes —
// none of which make sense on the multi-user PostgreSQL-backed library
// (you can't rename or delete a graph another user shared), which is why
// this stays a completely separate route family rather than an extension
// of /api/graphs. Additive to — never a replacement for — that shared
// library.
//
// Failure handling
// -----------------
// Every route is wrapped so a GraphRepository/Postgres failure never
// crashes this process or hangs the response — it logs server-side and
// replies 503, which the browser client treats exactly like "couldn't
// reach it," never a hard error (see this task's own "PostgreSQL
// unavailable must not break plotting" requirement, enforced end-to-end:
// this layer degrades gracefully, and so does the client that calls it).
// /health is deliberately outside that DB-touching contract entirely — see
// its own comment below for why.
//
// CORS
// -----
// CORS_ORIGIN (a comma-separated list, e.g. your GitHub Pages URL) governs
// which origins may call this API in production; unset (the local-dev
// default) allows any origin, matching this server's original
// architecture-scaffolding behavior. This is the one piece of this file
// that reads its own environment variable directly rather than going
// through GraphRepository — CORS is a transport/deployment concern, not
// business logic.

import { getGraphRepository } from '../repositories/graphRepository.js';
import { parseListOptions, parseSearchQuery } from './queryParsing.js';
import { parseLocalListOptions, parseLocalSearchQuery } from './localGraphQueryParsing.js';
import { graphDatabase as defaultGraphDatabase } from '../graphDatabase/graphDatabase.js';
import { readJsonBody, sendJson } from './httpHelpers.js';
import { handleAuthRoute } from './authRoutes.js';
import { handleAdminRoute } from './adminRoutes.js';
import { resolveAuthContext } from '../auth/requireAuth.js';
import { getMessageRepository } from '../repositories/messageRepository.js';

// Read per-request (not cached at module load) so a test can flip
// process.env.CORS_ORIGIN between cases in the same process — in
// production this is set once, before the process starts, so there's no
// behavioral difference, just better testability. '*' (the default)
// matches this server's original scaffolding behavior — see the module
// comment above for why tightening it is a deploy-time config choice
// (CORS_ORIGIN), not a code change.
const getAllowedOrigins = () => (process.env.CORS_ORIGIN ?? '*').split(',').map((origin) => origin.trim()).filter(Boolean);

const withCors = (req, res) => {
  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      // Tells caches (browser and any intermediary) that the response
      // varies by request Origin — required whenever this header echoes
      // back a specific origin instead of a fixed '*'.
      res.setHeader('Vary', 'Origin');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  // Authorization must be explicitly allowed here — every authenticated
  // route (resolveAuthContext, see requireAuth.js) reads the caller's JWT
  // from this header, and a browser's own CORS preflight blocks the real
  // request from ever being sent if the server doesn't grant it, with no
  // more specific error surfaced to the page than a generic failed fetch.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
};

/**
 * Builds the request listener `http.createServer` needs, bound to
 * `repository` (a GraphRepository instance — see createGraphRepository).
 * Taking the repository as a parameter, rather than reaching for the
 * shared singleton itself, is what lets tests exercise real HTTP
 * round-trips against a fake repository with no real database at all (see
 * api-app.test.mjs). `userRepository` is the same idea for auth — injected
 * through to every handleAuthRoute/resolveAuthContext call below so
 * auth-gated /api/graphs* tests never need a real database either (see
 * tests/api-app.test.mjs's own fake user repository).
 */
export const createApp = (repository, { graphDatabase: graphDb = defaultGraphDatabase, userRepository, messageRepository } = {}) => async (req, res) => {
  withCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  // Liveness check for the hosting platform (Render's healthCheckPath —
  // see render.yaml) and for anyone curling the server to confirm it's up.
  // Deliberately never touches GraphRepository/Postgres: a platform health
  // check flapping the service because of a transient DB hiccup would be
  // worse than a health check that only answers "is this process
  // responding," which is genuinely all a hosting platform needs to know
  // before routing traffic to it.
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  try {
    // Auth routes (signup/login/logout/me) — checked first since nothing
    // below needs them and they never touch GraphRepository.
    if (await handleAuthRoute(req, res, url, { userRepository })) return undefined;

    // Admin Dashboard routes and the /api/messages inbox both need
    // messageRepository — resolved lazily, only when a request is actually
    // headed for one of them, exactly like handleAuthRoute's own early
    // pathname guard avoids opening a database connection for every other
    // request (see that file's own comment on why this matters: without
    // the guard, every /api/graphs*/local-graphs* request would pay for —
    // and require — a Postgres connection it never needed).
    const needsMessageRepo = url.pathname.startsWith('/api/admin/') || url.pathname === '/api/messages' || url.pathname.startsWith('/api/messages/');
    const msgRepo = needsMessageRepo ? (messageRepository ?? await getMessageRepository()) : null;

    // Admin Dashboard routes — checked next, before the ordinary
    // /api/graphs* handling below, since /api/admin/* is a disjoint
    // prefix (see adminRoutes.js's own module comment for the full
    // role === 'admin' enforcement this delegates to).
    if (await handleAdminRoute(req, res, url, { repository, userRepository, messageRepository: msgRepo })) return undefined;

    // A signed-in user's own in-app inbox (see messageRepository.js's own
    // module comment — this backs "Message User"/"Push Update" from the
    // Admin Dashboard). Always scoped to the caller's own userId from
    // their token, never a path param, so this can never become a way to
    // read another user's messages.
    if (url.pathname === '/api/messages' || url.pathname.startsWith('/api/messages/')) {
      const auth = await resolveAuthContext(req, { userRepository });
      if (!auth) return sendJson(res, 401, { error: 'sign in required' });

      if (req.method === 'GET' && url.pathname === '/api/messages') {
        const messages = await msgRepo.listMessagesForUser(auth.userId);
        return sendJson(res, 200, { messages });
      }

      if (req.method === 'PATCH' && url.pathname.endsWith('/read')) {
        const id = decodeURIComponent(url.pathname.slice('/api/messages/'.length, -'/read'.length));
        const message = await msgRepo.markMessageRead(id, auth.userId);
        if (!message) return sendJson(res, 404, { error: 'no message with this id' });
        return sendJson(res, 200, { message });
      }
    }

    // Every /api/graphs* route below is now RDS's private, per-user
    // library — "Research Users can never view/search/edit/delete/load
    // another user's graphs" (the spec's own words). Requiring auth here,
    // not just in the frontend, is what makes that a real guarantee rather
    // than a UI convention someone could bypass by calling this API
    // directly. /api/local-graphs* (the separate file-based/GitHub-backed
    // local store below) is untouched — it's a different, single-tenant
    // storage system this pass doesn't change.
    if (url.pathname === '/api/graphs' || url.pathname === '/api/graphs/search' || url.pathname === '/api/graphs/recent' || url.pathname.startsWith('/api/graphs/')) {
      const auth = await resolveAuthContext(req, { userRepository });
      if (!auth) return sendJson(res, 401, { error: 'sign in required' });

      // Metadata-only browse/search routes — checked before the generic
      // /api/graphs/:hash fallback below (see this file's own route-table
      // comment on why order matters here). A non-admin's own filters are
      // always ANDed with (never replaced by) their own visibleToUserId —
      // forced here, at the one place a request from outside server/**
      // enters this file, rather than trusted from the query string, so a
      // Research User can never ask this route for someone else's graphs
      // no matter what they pass. visibleToUserId (not ownerUserId) is
      // what makes an admin-pushed graph appear in a Research User's own
      // library too (see buildGraphFilterClause's own comment) — Admin
      // sees every owner's graphs regardless (the spec's own "Admin: view
      // every user... every graph").
      const ownerScope = auth.role === 'admin' ? {} : { visibleToUserId: auth.userId };

      if (req.method === 'GET' && url.pathname === '/api/graphs') {
        const options = parseListOptions(url.searchParams);
        const graphs = await repository.listGraphs({ ...options, filters: { ...options.filters, ...ownerScope } });
        return sendJson(res, 200, { graphs });
      }

      if (req.method === 'GET' && url.pathname === '/api/graphs/search') {
        const query = parseSearchQuery(url.searchParams);
        const options = parseListOptions(url.searchParams);
        const graphs = await repository.searchGraphs(query, { ...options, filters: { ...options.filters, ...ownerScope } });
        return sendJson(res, 200, { graphs });
      }

      if (req.method === 'GET' && url.pathname === '/api/graphs/recent') {
        const options = parseListOptions(url.searchParams);
        const graphs = await repository.listRecentGraphs({ ...options, filters: { ...options.filters, ...ownerScope } });
        return sendJson(res, 200, { graphs });
      }

      // Download by id (not hash) — backs the inbox's "Load Graph" button
      // (see adminClient.js's own loadGraphById): a pushed graph's inbox
      // message only carries relatedGraphId (graph_shares/user_messages
      // are keyed by id, not hash — see those migrations), so the
      // recipient needs a by-id lookup rather than already knowing the
      // hash. Checked before the generic /api/graphs/:hash fallback below
      // (same reasoning as /search and /recent above — "by-id" would
      // otherwise be treated as a literal hash). Same ownership/share
      // check as the by-hash download route below.
      if (req.method === 'GET' && url.pathname.startsWith('/api/graphs/by-id/')) {
        const graphId = decodeURIComponent(url.pathname.slice('/api/graphs/by-id/'.length));
        if (!graphId) return sendJson(res, 400, { error: 'missing id' });
        const graph = await repository.findById(graphId);
        if (!graph) return sendJson(res, 200, { exists: false });
        if (auth.role !== 'admin' && graph.ownerUserId && graph.ownerUserId !== auth.userId) {
          const shared = await repository.userCanAccessGraph(graph.id, auth.userId);
          if (!shared) return sendJson(res, 403, { error: "you don't have access to this graph" });
        }
        const found = await repository.getGraphWithGeometry(graph.hash);
        if (found) repository.recordGraphAccess(graph.hash).catch((err) => console.error('[graph-api] recordGraphAccess failed:', err));
        return sendJson(res, 200, found ? { exists: true, ...found } : { exists: false });
      }

      // Download: the one route that returns full geometry, for exactly
      // one graph at a time — never while browsing (see this task's own
      // "avoid unnecessary database calls" / "never download geometry
      // while browsing"). Ownership is checked *after* the fetch (this
      // query is by hash, not scoped by owner like the listing routes
      // above) — a graph with no owner at all (legacy data from before
      // this feature, or explicitly unowned) is never "someone else's",
      // so it stays readable; a graph owned by a different user is a 403
      // *unless* an admin has pushed it to this user (graph_shares —
      // checked as a fallback, not the first branch, so the common case of
      // downloading your own graph never pays for the extra query), never
      // a silent {exists:false} that would look like a bug rather than a
      // permission boundary.
      if (req.method === 'GET' && url.pathname.startsWith('/api/graphs/')) {
        const hash = decodeURIComponent(url.pathname.slice('/api/graphs/'.length));
        if (!hash) return sendJson(res, 400, { error: 'missing hash' });
        const found = await repository.getGraphWithGeometry(hash);
        if (found && auth.role !== 'admin' && found.graph.ownerUserId && found.graph.ownerUserId !== auth.userId) {
          const shared = await repository.userCanAccessGraph(found.graph.id, auth.userId);
          if (!shared) return sendJson(res, 403, { error: "you don't have access to this graph" });
        }
        if (found) {
          // Usage tracking is a side effect of a successful *download*,
          // never of browsing/searching — fire-and-forget (not awaited) so
          // a slow or failed counter update can never delay or break the
          // download response itself.
          repository.recordGraphAccess(hash).catch((err) => console.error('[graph-api] recordGraphAccess failed:', err));
        }
        return sendJson(res, 200, found ? { exists: true, ...found } : { exists: false });
      }

      if (req.method === 'POST' && url.pathname === '/api/graphs') {
        const body = await readJsonBody(req);
        if (!body.params || !Array.isArray(body.points)) {
          return sendJson(res, 400, { error: 'params and points are required' });
        }
        // ownerUserId always comes from the authenticated session, never
        // from the request body — otherwise any signed-in user could save
        // a graph into someone else's private library just by naming them.
        const result = await repository.uploadExactGraphIfMissing({ ...body, ownerUserId: auth.userId });
        return sendJson(res, 200, result);
      }
    }

    // Local file-based GraphDatabase's own metadata-only browse/search —
    // mirrors the PostgreSQL routes' own "metadata only while browsing"
    // rule (graphDatabase.js's listGraphs/searchGraphs never return
    // points, same as GraphRepository's queryGraphs). Checked before the
    // generic GET /api/local-graphs/:hash fallback below (see this file's
    // own route-table comment).
    if (req.method === 'GET' && url.pathname === '/api/local-graphs') {
      const graphs = await graphDb.listGraphs(parseLocalListOptions(url.searchParams));
      return sendJson(res, 200, { graphs });
    }

    if (req.method === 'GET' && url.pathname === '/api/local-graphs/search') {
      const query = parseLocalSearchQuery(url.searchParams);
      const graphs = await graphDb.searchGraphs(query, parseLocalListOptions(url.searchParams));
      return sendJson(res, 200, { graphs });
    }

    // Local file-based GraphDatabase — the permanent render cache. Same
    // shape as the PostgreSQL download route ({exists, graph} vs.
    // {exists: false}), just a different backing store and a `graph`
    // field name (not `geometry`) matching graphDatabase.js's own
    // {id, hash, metadata, points, notes} object.
    if (req.method === 'GET' && url.pathname.startsWith('/api/local-graphs/')) {
      const hash = decodeURIComponent(url.pathname.slice('/api/local-graphs/'.length));
      if (!hash) return sendJson(res, 400, { error: 'missing hash' });
      const graph = await graphDb.loadGraph(hash);
      return sendJson(res, 200, graph ? { exists: true, graph } : { exists: false });
    }

    if (req.method === 'POST' && url.pathname === '/api/local-graphs') {
      const body = await readJsonBody(req);
      if (!body.params || !Array.isArray(body.points)) {
        return sendJson(res, 400, { error: 'params and points are required' });
      }
      const graph = await graphDb.saveGraph(body);
      return sendJson(res, 200, { saved: true, graph });
    }

    // Metadata-only edit (rename/favorite/tags/notes/visibility/color) for
    // the Graph Database browser — never touches points.json (see
    // graphDatabase.js's own updateGraphMetadata). 404s (not 503) for a
    // hash that was never saved, since that's a client mistake (a stale
    // card, or a hash that was already deleted), not a storage failure.
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/local-graphs/')) {
      const hash = decodeURIComponent(url.pathname.slice('/api/local-graphs/'.length));
      if (!hash) return sendJson(res, 400, { error: 'missing hash' });
      const body = await readJsonBody(req);
      if (!(await graphDb.graphExists(hash))) return sendJson(res, 404, { error: 'no graph stored for this hash' });
      const metadata = await graphDb.updateGraphMetadata(hash, body);
      return sendJson(res, 200, { updated: true, metadata });
    }

    // Delete a graph from the local library entirely (metadata, points,
    // and notes together — see graphDatabase.js's own deleteGraph). Always
    // 200 { deleted: true }, even if the hash was never stored: deleting
    // something that's already gone is exactly the state the caller
    // wanted, not an error (same idempotent-delete convention as most REST
    // APIs' DELETE routes).
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/local-graphs/')) {
      const hash = decodeURIComponent(url.pathname.slice('/api/local-graphs/'.length));
      if (!hash) return sendJson(res, 400, { error: 'missing hash' });
      await graphDb.deleteGraph(hash);
      return sendJson(res, 200, { deleted: true });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[graph-api] request failed:', err);
    sendJson(res, 503, { error: 'database unavailable' });
  }
};

// Convenience for the CLI entry point and tests that don't want to build
// their own repository: the app bound to the real shared pool.
export const createDefaultApp = async () => createApp(await getGraphRepository());
