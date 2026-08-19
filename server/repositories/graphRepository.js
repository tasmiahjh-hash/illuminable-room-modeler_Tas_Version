// GraphRepository: the ONLY module in this entire project allowed to
// execute SQL against the `graphs`/`graph_geometry`/`graph_jobs` tables.
// This is a hard rule, not just a convention: future code — an API route,
// a background worker, anything — must call a method here, never build or
// run a query of its own. Centralizing every query in one file is what
// makes the schema's actual contract auditable in one place, and what
// makes swapping *how* a query runs (connection pooling, read replicas,
// caching, a future ORM) a change entirely internal to this file.
//
// (server/db/migrate.js is the one structural exception: it runs schema-
// management SQL — CREATE TABLE, the schema_migrations bookkeeping — which
// is a deployment/ops concern, not the business-logic graph queries this
// rule is actually about.)
//
// Reached from the browser through server/api/** only (Phase 5)
// -------------------------------------------------------------------------
// A browser tab can't open a raw Postgres connection at all — TCP sockets
// aren't available to it — so server/api/app.js is the thin HTTP layer that
// src/anglePlot/remoteGraphRepository.js's fetch calls actually hit; that
// route handler is the *only* caller of this file from outside server/**.
// Nothing in src/** imports this file directly, and rendering code still
// never executes SQL, exactly as this module's own header rule requires —
// it just now has exactly one caller (the API layer) instead of zero.
// GraphCache's own Stage 3 comment (src/anglePlot/graphCache.js) describes
// the browser-side shape this integration takes: GraphCache.get/set stays
// the same interface, with a remote lookup/upload now sitting behind a
// GraphCache miss instead of the whole feature not existing yet.
//
// Every method takes a `hash` produced by src/anglePlot/graphHasher.js's
// hashGraph — the same permanent identity the in-memory GraphCache and the
// background job queue already use, so a graph's identity is never
// redefined a third way at this layer.

import { getPool } from '../db/pool.js';
import { hashGraph, GRAPH_HASH_ALGORITHM_VERSION } from '../../src/anglePlot/graphHasher.js';
import { GRAPH_STATUS } from '../../src/anglePlot/graphStatus.js';
import { graphRowToModel, graphMetadataRowToModel, graphVersionRowToModel } from '../models/graph.js';
import { geometryRowToModel } from '../models/geometry.js';

// Shared graph library (Phase 6): browsing, search, sort, and filter over
// every stored graph's *metadata* — never geometry (see queryGraphs' own
// comment). One sort enum, one filter-clause builder, and one underlying
// query (queryGraphs) back every listing method below
// (listGraphs/searchGraphs/listGraphsByUser/listRecentGraphs/
// listPopularGraphs/getGraphMetadata) so there is exactly one place this
// SQL is ever written, not five.

/** Sort orders queryGraphs accepts — see SORT_CLAUSES for what each maps to. */
export const GRAPH_SORT = {
  NEWEST: 'newest',
  OLDEST: 'oldest',
  RECENTLY_COMPUTED: 'recently_computed',
  RECENTLY_USED: 'recently_used',
  MOST_DOWNLOADED: 'most_downloaded',
};

// Whitelisted, never built from user input directly — a sort value that
// isn't a real key here falls back to NEWEST (see queryGraphs) rather than
// ever being interpolated into ORDER BY.
const SORT_CLAUSES = {
  [GRAPH_SORT.NEWEST]: 'g.created_at DESC',
  [GRAPH_SORT.OLDEST]: 'g.created_at ASC',
  // A graph's geometry can (in principle — see Stage 2/refinement notes
  // elsewhere in this codebase) be recomputed after the graph row itself
  // was created, so "recently computed" reads graph_geometry's own
  // updated_at, not the graph row's.
  [GRAPH_SORT.RECENTLY_COMPUTED]: 'gg.updated_at DESC NULLS LAST',
  [GRAPH_SORT.RECENTLY_USED]: 'g.last_accessed_at DESC NULLS LAST',
  [GRAPH_SORT.MOST_DOWNLOADED]: 'g.download_count DESC',
};

const DEFAULT_LIST_LIMIT = 50;
// Hard cap regardless of what a caller (ultimately, an HTTP query string)
// asks for, so a single browse/search request can never turn into an
// unbounded table scan's worth of rows serialized into one response.
const MAX_LIST_LIMIT = 200;

// graphs LEFT JOIN graph_geometry (not INNER — see graphMetadataRowToModel's
// own comment): a graph without geometry yet still needs to appear in a
// listing, just reporting hasExactGeometry: false, rather than vanishing
// from it entirely the way getGraphWithGeometry's own INNER JOIN
// deliberately does for its different (single-graph, geometry-required)
// use case.
const METADATA_SELECT = `
  SELECT
    g.id, g.hash, g.sequence_text, g.angle_a, g.angle_b, g.angle_step_input, g.base_length,
    g.algorithm_version, g.owner_user_id, g.created_at, g.updated_at,
    g.download_count, g.last_accessed_at,
    g.owner_name, g.title, g.description, g.max_bounces, g.graph_color_hex,
    g.tags, g.favorite, g.visibility, g.notes, g.current_version, g.deleted_at,
    gg.point_count, gg.updated_at AS geometry_updated_at,
    (gg.id IS NOT NULL) AS has_exact_geometry
  FROM graphs g
  LEFT JOIN graph_geometry gg ON gg.graph_id = g.id
`;

// Same shape as METADATA_SELECT, plus the current owner's email/display name
// (a live join, not the graphs table's own denormalized owner_name column —
// see 0008's own comment on why that column exists separately) — only the
// Admin Dashboard's cross-user views need this; ordinary browsing never
// shows another user's identity, so METADATA_SELECT stays as-is for it.
const ADMIN_METADATA_SELECT = `
  SELECT
    g.id, g.hash, g.sequence_text, g.angle_a, g.angle_b, g.angle_step_input, g.base_length,
    g.algorithm_version, g.owner_user_id, g.created_at, g.updated_at,
    g.download_count, g.last_accessed_at,
    g.owner_name, g.title, g.description, g.max_bounces, g.graph_color_hex,
    g.tags, g.favorite, g.visibility, g.notes, g.current_version, g.deleted_at,
    gg.point_count, gg.updated_at AS geometry_updated_at,
    (gg.id IS NOT NULL) AS has_exact_geometry,
    u.email AS owner_email, u.display_name AS owner_display_name
  FROM graphs g
  LEFT JOIN graph_geometry gg ON gg.graph_id = g.id
  LEFT JOIN users u ON u.id = g.owner_user_id
`;

/**
 * Builds the WHERE clause and positional params for every filter
 * queryGraphs supports — the one place this SQL is written. Extension
 * point for future filters (tags, favorites, ownership/permission scopes):
 * each becomes one more `if` below, appended to the same clauses/params
 * array; nothing about queryGraphs' own call sites needs to change.
 *
 * hash/sequenceText are partial (ILIKE '%...%') — see this phase's own
 * "search should support partial matches where appropriate." Numeric
 * fields (angleA/angleB/baseLength) and identifiers (ownerUserId,
 * algorithmVersion) are exact matches; a future min/max range filter for
 * the numeric fields would add its own `angleAMin`/`angleAMax`-style
 * branches here without touching the exact-match ones.
 */
const buildGraphFilterClause = (filters = {}) => {
  const clauses = [];
  const params = [];
  const push = (column, operator, value) => {
    params.push(value);
    clauses.push(`${column} ${operator} $${params.length}`);
  };

  // hashExact is used by getGraphMetadata (a single, known hash) so it
  // never pays for (or risks a false-positive substring match from) an
  // ILIKE scan the way the free-text search field below does.
  if (filters.hashExact) push('g.hash', '=', filters.hashExact);
  else if (filters.hash) push('g.hash', 'ILIKE', `%${filters.hash}%`);
  if (filters.sequenceText) push('g.sequence_text', 'ILIKE', `%${filters.sequenceText}%`);
  if (filters.angleA !== undefined) push('g.angle_a', '=', filters.angleA);
  if (filters.angleB !== undefined) push('g.angle_b', '=', filters.angleB);
  if (filters.baseLength !== undefined) push('g.base_length', '=', filters.baseLength);
  if (filters.ownerUserId) push('g.owner_user_id', '=', filters.ownerUserId);
  // A non-admin's own "library" view: everything they own, plus everything
  // an admin has pushed to them (see graph_shares/pushGraphToUser) — an OR,
  // not a second AND-ed clause, so it can't be expressed via the generic
  // push() helper above. Mutually exclusive with ownerUserId in practice
  // (server/api/app.js's route handlers only ever set one or the other).
  if (filters.visibleToUserId) {
    params.push(filters.visibleToUserId);
    const idx = params.length;
    clauses.push(`(g.owner_user_id = $${idx} OR g.id IN (SELECT graph_id FROM graph_shares WHERE recipient_user_id = $${idx}))`);
  }
  if (filters.algorithmVersion !== undefined) push('g.algorithm_version', '=', filters.algorithmVersion);
  if (filters.createdAfter) push('g.created_at', '>=', filters.createdAfter);
  if (filters.createdBefore) push('g.created_at', '<=', filters.createdBefore);
  if (filters.onlyExactGraphs) clauses.push('gg.id IS NOT NULL');

  // Soft-deleted graphs (see 0008's own comment on deleted_at) never appear
  // in an ordinary listing — only the Admin Dashboard's own diagnostics/
  // restore views pass includeDeleted to see them. onlyDeleted narrows a
  // query to just the trash (the dashboard's own "deleted graphs" view).
  if (filters.onlyDeleted) clauses.push('g.deleted_at IS NOT NULL');
  else if (!filters.includeDeleted) clauses.push('g.deleted_at IS NULL');

  return { whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
};

/**
 * Builds a GraphRepository bound to `pool` (anything with an async
 * `query(text, params)` — a real pg.Pool, or a fake for tests; see
 * graphRepository.test.mjs). A factory rather than a module-level
 * singleton so tests never need a real database connection to exercise
 * this file's own query-building logic.
 */
export const createGraphRepository = (pool) => ({
  /** The graph with this hash, or null if it's never been seen before. */
  async findByHash(hash) {
    const { rows } = await pool.query('SELECT * FROM graphs WHERE hash = $1', [hash]);
    return rows[0] ? graphRowToModel(rows[0]) : null;
  },

  /**
   * Inserts a graph for `params` if its hash has never been seen, or
   * returns the existing row unchanged otherwise (the permanent identity
   * is content-derived — there is nothing to "update" about an existing
   * graph's own params, only its updated_at bookkeeping).
   */
  async upsertGraph({ params, ownerUserId = null, algorithmVersion = GRAPH_HASH_ALGORITHM_VERSION }) {
    const hash = hashGraph(params);
    const { rows } = await pool.query(
      `INSERT INTO graphs (hash, sequence_text, angle_a, angle_b, angle_step_input, base_length, algorithm_version, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (hash) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [hash, params.sequenceText, params.angleA, params.angleB, params.angleStepInput, params.baseLength, algorithmVersion, ownerUserId],
    );
    return graphRowToModel(rows[0]);
  },

  /** The current stored geometry for a graph, or null if none has been computed yet. */
  async getGeometry(graphId) {
    const { rows } = await pool.query('SELECT * FROM graph_geometry WHERE graph_id = $1', [graphId]);
    return rows[0] ? geometryRowToModel(rows[0]) : null;
  },

  /**
   * Replaces (or creates) a graph's stored geometry — one row per graph
   * (see the graph_geometry migration's own comment on why this isn't a
   * history table).
   */
  async saveGeometry(graphId, { points, status, durationMs = null }) {
    const { rows } = await pool.query(
      `INSERT INTO graph_geometry (graph_id, points, point_count, status, duration_ms)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (graph_id) DO UPDATE SET
         points = $2, point_count = $3, status = $4, duration_ms = $5, updated_at = now()
       RETURNING *`,
      [graphId, JSON.stringify(points), points.length, status, durationMs],
    );
    return geometryRowToModel(rows[0]);
  },

  /**
   * Whether a graph with this hash has ever been stored — no geometry, no
   * row contents, just existence. Used by the upload pipeline's own
   * pre-check (see uploadExactGraphIfMissing) and available to any future
   * caller that only needs a yes/no answer without paying for a full row
   * fetch.
   */
  async graphExists(hash) {
    const { rows } = await pool.query('SELECT 1 FROM graphs WHERE hash = $1', [hash]);
    return rows.length > 0;
  },

  /**
   * The download pipeline's one call: graph *and* its geometry in a single
   * round trip (an INNER JOIN), rather than findByHash followed by a
   * separate getGeometry — avoiding the unnecessary second database call
   * this task explicitly asks to avoid. The INNER JOIN also means a graph
   * row that somehow exists without geometry yet (shouldn't normally
   * happen — see saveGeometry/uploadExactGraphIfMissing, which always
   * write both together) is correctly treated as "no exact graph
   * available" rather than a partial/broken result.
   *
   * @returns {{graph, geometry}|null}
   */
  async getGraphWithGeometry(hash) {
    const { rows } = await pool.query(
      `SELECT
         g.*,
         gg.id AS geometry_id, gg.points, gg.point_count, gg.status AS geometry_status,
         gg.duration_ms, gg.created_at AS geometry_created_at, gg.updated_at AS geometry_updated_at
       FROM graphs g
       JOIN graph_geometry gg ON gg.graph_id = g.id
       WHERE g.hash = $1`,
      [hash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      graph: graphRowToModel(row),
      geometry: {
        id: row.geometry_id, graphId: row.id, points: row.points, pointCount: row.point_count,
        status: row.geometry_status, durationMs: row.duration_ms,
        createdAt: row.geometry_created_at, updatedAt: row.geometry_updated_at,
      },
    };
  },

  /**
   * The upload pipeline's one call: stores a freshly-computed exact graph
   * only if this hash has never been stored before ("duplicate uploads
   * never occur" — see this task's own test list). Graph metadata and
   * geometry are saved together, since a graph row is never meant to exist
   * here without its geometry (see getGraphWithGeometry's own comment) —
   * there is no reason a caller would ever want one without the other.
   *
   * @returns {{uploaded: boolean, graph?, geometry?}} `uploaded` is false
   *   (with no graph/geometry) when the hash already existed — the caller
   *   (see AnglePlotWindow.jsx) treats this exactly the same as a
   *   successful upload: either way, the shared library now has it.
   */
  async uploadExactGraphIfMissing({ params, algorithmVersion = GRAPH_HASH_ALGORITHM_VERSION, ownerUserId = null, points, durationMs = null }) {
    const hash = hashGraph(params);
    if (await this.graphExists(hash)) return { uploaded: false };
    const graph = await this.upsertGraph({ params, ownerUserId, algorithmVersion });
    const geometry = await this.saveGeometry(graph.id, { points, status: GRAPH_STATUS.EXACT, durationMs });
    return { uploaded: true, graph, geometry };
  },

  // --- Shared graph library: browse, search, sort, filter (Phase 6) ------

  /**
   * The one query every listing/search method below delegates to — see
   * buildGraphFilterClause and SORT_CLAUSES for the filter/sort vocabulary
   * this accepts. Always returns metadata only (graphMetadataRowToModel),
   * never geometry, and always paginated (limit/offset), so a caller can
   * never accidentally trigger an unbounded scan-and-serialize of the
   * entire library.
   *
   * @param {object} [options]
   * @param {object} [options.filters] - see buildGraphFilterClause.
   * @param {string} [options.sort] - one of GRAPH_SORT; defaults to NEWEST.
   * @param {number} [options.limit] - defaults to DEFAULT_LIST_LIMIT, capped at MAX_LIST_LIMIT.
   * @param {number} [options.offset] - defaults to 0.
   */
  async queryGraphs({ filters = {}, sort = GRAPH_SORT.NEWEST, limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
    const { whereSql, params } = buildGraphFilterClause(filters);
    const orderBySql = SORT_CLAUSES[sort] ?? SORT_CLAUSES[GRAPH_SORT.NEWEST];
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const { rows } = await pool.query(
      `${METADATA_SELECT} ${whereSql} ORDER BY ${orderBySql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, safeLimit, safeOffset],
    );
    return rows.map(graphMetadataRowToModel);
  },

  /** Every stored graph's metadata, optionally filtered/sorted/paginated — the shared library's general browse call. */
  async listGraphs(options = {}) {
    return this.queryGraphs(options);
  },

  /**
   * Free-text/exact search over the library. `query` supplies the
   * searchable fields (hash, sequenceText, angleA, angleB, baseLength —
   * see buildGraphFilterClause for which are partial vs. exact matches);
   * `options` supplies sort/pagination/additional filters exactly like
   * listGraphs, layered on top of `query`.
   */
  async searchGraphs(query = {}, options = {}) {
    return this.queryGraphs({ ...options, filters: { ...query, ...options.filters } });
  },

  /** Every graph owned by a given user — future-compatible: no auth exists yet, but the column/filter already does. */
  async listGraphsByUser(ownerUserId, options = {}) {
    return this.queryGraphs({ ...options, filters: { ...options.filters, ownerUserId } });
  },

  /** The newest graphs in the library — queryGraphs' own default sort, exposed as its own named call per this phase's own API examples. */
  async listRecentGraphs(options = {}) {
    return this.queryGraphs({ ...options, sort: options.sort ?? GRAPH_SORT.NEWEST });
  },

  /** The most-downloaded graphs in the library. */
  async listPopularGraphs(options = {}) {
    return this.queryGraphs({ ...options, sort: options.sort ?? GRAPH_SORT.MOST_DOWNLOADED });
  },

  /**
   * One graph's metadata by its exact hash — no geometry (see
   * getGraphWithGeometry for that). Reuses queryGraphs' own filter/mapping
   * logic (via the exact-match `hashExact` filter) rather than writing a
   * separate SELECT, so this and every listing method stay in sync by
   * construction.
   */
  async getGraphMetadata(hash) {
    const results = await this.queryGraphs({ filters: { hashExact: hash }, limit: 1 });
    return results[0] ?? null;
  },

  /**
   * Records that a graph was downloaded/used — called from the download
   * route (server/api/app.js) on a successful GET /api/graphs/:hash, never
   * from browsing/search/upload. Backs the RECENTLY_USED and
   * MOST_DOWNLOADED sort orders.
   */
  async recordGraphAccess(hash) {
    await pool.query(
      'UPDATE graphs SET download_count = download_count + 1, last_accessed_at = now() WHERE hash = $1',
      [hash],
    );
  },

  /** Records a new background job request for a graph, in 'queued' status. */
  async createJob({ graphId, priority }) {
    const { rows } = await pool.query(
      `INSERT INTO graph_jobs (graph_id, status, priority) VALUES ($1, 'queued', $2) RETURNING *`,
      [graphId, priority],
    );
    return rows[0];
  },

  /** Updates a job's status and (optionally) its started/finished timestamps or error. */
  async updateJobStatus(jobId, { status, startedAt = null, finishedAt = null, errorMessage = null }) {
    const { rows } = await pool.query(
      `UPDATE graph_jobs SET
         status = $2,
         started_at = COALESCE($3, started_at),
         finished_at = COALESCE($4, finished_at),
         error_message = $5
       WHERE id = $1
       RETURNING *`,
      [jobId, status, startedAt, finishedAt, errorMessage],
    );
    return rows[0] ?? null;
  },

  // --- Admin Dashboard (deferred RDS phase) -------------------------------
  // Every method below is reached only from server/api/adminRoutes.js,
  // which is itself gated on role === 'admin' (see requireAuth.js) — this
  // file stays the only place that builds SQL, exactly as its own header
  // rule requires, but these queries are deliberately never reachable from
  // an ordinary (non-admin) route.

  /**
   * Whether `userId` may read this graph: owns it, or an admin has pushed
   * it to them (see graph_shares/pushGraphToUser). Used only as a fallback
   * check on the download route — the common case (a user downloading
   * their own graph) never reaches this, since that's already true from
   * the row's own owner_user_id (see app.js's own download-route comment).
   */
  async userCanAccessGraph(graphId, userId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM graphs g
       WHERE g.id = $1 AND (
         g.owner_user_id = $2
         OR EXISTS (SELECT 1 FROM graph_shares s WHERE s.graph_id = g.id AND s.recipient_user_id = $2)
       )`,
      [graphId, userId],
    );
    return rows.length > 0;
  },

  /**
   * Admin "Push Graph to User": grants `recipientUserId` read access to an
   * existing graph without touching the graph's own row at all (see the
   * graph_shares migration's own comment on why this is a grant, never a
   * copy or an ownership transfer). Idempotent — pushing the same graph to
   * the same user twice is a no-op, not a second row (the UNIQUE
   * constraint's own ON CONFLICT DO NOTHING).
   *
   * @returns {{pushed: boolean, share?}} `pushed` is false when this user
   *   already had access — the caller (adminRoutes.js) skips sending a
   *   second "Admin sent you a graph" notification in that case.
   */
  async pushGraphToUser({ graphId, recipientUserId, pushedByAdminId }) {
    const { rows } = await pool.query(
      `INSERT INTO graph_shares (graph_id, recipient_user_id, pushed_by_admin_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (graph_id, recipient_user_id) DO NOTHING
       RETURNING *`,
      [graphId, recipientUserId, pushedByAdminId],
    );
    if (!rows[0]) return { pushed: false };
    return {
      pushed: true,
      share: {
        id: rows[0].id, graphId: rows[0].graph_id, recipientUserId: rows[0].recipient_user_id,
        pushedByAdminId: rows[0].pushed_by_admin_id, createdAt: rows[0].created_at,
      },
    };
  },

  /** One graph by its own id (not hash) — admin routes address a graph by id since that's what every list/diagnostic view returns. Includes soft-deleted graphs (an admin must be able to look up a graph it's about to restore). */
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM graphs WHERE id = $1', [id]);
    return rows[0] ? graphRowToModel(rows[0]) : null;
  },

  /**
   * The Admin Dashboard's own "all graphs across every owner" browse/search
   * — same filter/sort vocabulary as queryGraphs (buildGraphFilterClause),
   * but selects the live owner email/display name via ADMIN_METADATA_SELECT
   * instead of the plain library's METADATA_SELECT, since only an admin
   * view is allowed to show another user's identity.
   */
  async queryGraphsAdmin({ filters = {}, sort = GRAPH_SORT.NEWEST, limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
    const { whereSql, params } = buildGraphFilterClause(filters);
    const orderBySql = SORT_CLAUSES[sort] ?? SORT_CLAUSES[GRAPH_SORT.NEWEST];
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const { rows } = await pool.query(
      `${ADMIN_METADATA_SELECT} ${whereSql} ORDER BY ${orderBySql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, safeLimit, safeOffset],
    );
    return rows.map(graphMetadataRowToModel);
  },

  /** Background jobs that ended in 'failed', newest-requested-first, joined to the graph's own hash/title/owner for the diagnostics list. */
  async findFailedJobs({ limit = 50 } = {}) {
    const { rows } = await pool.query(
      `SELECT j.*, g.hash AS graph_hash, g.title AS graph_title, g.owner_user_id
       FROM graph_jobs j
       JOIN graphs g ON g.id = j.graph_id
       WHERE j.status = 'failed'
       ORDER BY j.requested_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      jobId: row.id, graphId: row.graph_id, graphHash: row.graph_hash, graphTitle: row.graph_title,
      ownerUserId: row.owner_user_id, priority: row.priority, requestedAt: row.requested_at,
      startedAt: row.started_at, finishedAt: row.finished_at, errorMessage: row.error_message,
    }));
  },

  /**
   * Geometry rows whose stored point_count doesn't match their own points
   * array (or claim 'exact' status with zero points) — a graph whose
   * geometry has drifted from a consistent state, the thing "Repair Graph"
   * exists to fix. Never a plotting/geometry recompute — see repairGraph's
   * own comment for why this stays a pure data-integrity check.
   */
  async findCorruptedGraphs() {
    const { rows } = await pool.query(
      `SELECT gg.*, g.hash AS graph_hash, g.title AS graph_title, g.owner_user_id
       FROM graph_geometry gg
       JOIN graphs g ON g.id = gg.graph_id
       WHERE g.deleted_at IS NULL
         AND (gg.point_count IS DISTINCT FROM jsonb_array_length(gg.points)
              OR (gg.status = 'exact' AND gg.point_count = 0))
       ORDER BY gg.updated_at DESC`,
    );
    return rows.map((row) => ({
      geometryId: row.id, graphId: row.graph_id, graphHash: row.graph_hash, graphTitle: row.graph_title,
      ownerUserId: row.owner_user_id, storedPointCount: row.point_count,
      actualPointCount: Array.isArray(row.points) ? row.points.length : null, status: row.status,
    }));
  },

  /**
   * Graphs sharing the same logical parameters (sequence/angles/base
   * length) but stored as separate rows — the only way this can legitimately
   * happen, since `graphs.hash` is UNIQUE, is the same parameters hashed
   * under different `algorithm_version`s (see graphHasher.js's own
   * versioning). Surfaces those groups for the Admin Dashboard's "Duplicate
   * Hash Diagnostics" rather than ever claiming a literal hash collision,
   * which the UNIQUE constraint already makes impossible.
   */
  async findDuplicateParameterSets() {
    const { rows } = await pool.query(
      `SELECT sequence_text, angle_a, angle_b, angle_step_input, base_length,
         COUNT(*) AS duplicate_count,
         array_agg(json_build_object('id', id, 'hash', hash, 'algorithmVersion', algorithm_version, 'createdAt', created_at) ORDER BY created_at) AS graphs
       FROM graphs
       WHERE deleted_at IS NULL
       GROUP BY sequence_text, angle_a, angle_b, angle_step_input, base_length
       HAVING COUNT(*) > 1
       ORDER BY COUNT(*) DESC`,
    );
    return rows.map((row) => ({
      params: {
        sequenceText: row.sequence_text, angleA: row.angle_a, angleB: row.angle_b,
        angleStepInput: row.angle_step_input, baseLength: row.base_length,
      },
      duplicateCount: Number(row.duplicate_count),
      graphs: row.graphs,
    }));
  },

  /** Soft-deletes a graph (see 0008's deleted_at) — never a real DELETE, so restoreGraph always has something to restore. Returns the updated model, or null if no graph has this id. */
  async softDeleteGraph(id) {
    const { rows } = await pool.query('UPDATE graphs SET deleted_at = now() WHERE id = $1 RETURNING *', [id]);
    return rows[0] ? graphRowToModel(rows[0]) : null;
  },

  /** Reverses softDeleteGraph. Returns the updated model, or null if no graph has this id. */
  async restoreGraph(id) {
    const { rows } = await pool.query('UPDATE graphs SET deleted_at = NULL WHERE id = $1 RETURNING *', [id]);
    return rows[0] ? graphRowToModel(rows[0]) : null;
  },

  /**
   * Admin-scoped metadata edit — unlike a research user's own save flow,
   * this can target *any* graph regardless of ownership (see
   * adminRoutes.js's own role check for the only gate on that). Each field
   * is independently optional: an omitted (undefined) field keeps its
   * current value via COALESCE, so a caller only sends what it's changing.
   */
  async updateGraphMetadataAdmin(id, { title, description, tags, favorite, visibility, notes, graphColorHex, maxBounces, ownerName } = {}) {
    const { rows } = await pool.query(
      `UPDATE graphs SET
         title = COALESCE($2, title),
         description = COALESCE($3, description),
         tags = COALESCE($4, tags),
         favorite = COALESCE($5, favorite),
         visibility = COALESCE($6, visibility),
         notes = COALESCE($7, notes),
         graph_color_hex = COALESCE($8, graph_color_hex),
         max_bounces = COALESCE($9, max_bounces),
         owner_name = COALESCE($10, owner_name),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, title ?? null, description ?? null, tags ?? null, favorite ?? null, visibility ?? null,
        notes ?? null, graphColorHex ?? null, maxBounces ?? null, ownerName ?? null],
    );
    return rows[0] ? graphRowToModel(rows[0]) : null;
  },

  /**
   * Archives the graph's *current* live state (metadata + geometry) as a
   * graph_versions row, then bumps graphs.current_version — called by
   * repairGraph/restoreVersion/updateGraphMetadataAdmin's own callers
   * before they change anything, so the state being superseded is never
   * lost (see the graph_versions migration's own "never a diff" comment).
   * Returns the archived version's model, or null if the graph doesn't
   * exist.
   */
  async recordVersion(graphId, { changeReason, changedByUserId = null }) {
    const { rows: graphRows } = await pool.query('SELECT * FROM graphs WHERE id = $1', [graphId]);
    const graphRow = graphRows[0];
    if (!graphRow) return null;
    const { rows: geomRows } = await pool.query('SELECT * FROM graph_geometry WHERE graph_id = $1', [graphId]);
    const geomRow = geomRows[0] ?? { points: [], point_count: 0 };
    const { rows } = await pool.query(
      `INSERT INTO graph_versions
         (graph_id, version_number, title, tags, notes, graph_color_hex, visibility, favorite, points, point_count, change_reason, changed_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (graph_id, version_number) DO NOTHING
       RETURNING *`,
      [graphId, graphRow.current_version, graphRow.title, graphRow.tags, graphRow.notes,
        graphRow.graph_color_hex, graphRow.visibility, graphRow.favorite,
        JSON.stringify(geomRow.points), geomRow.point_count, changeReason, changedByUserId],
    );
    await pool.query('UPDATE graphs SET current_version = current_version + 1 WHERE id = $1', [graphId]);
    return rows[0] ? graphVersionRowToModel(rows[0]) : null;
  },

  /** Every saved version for a graph, newest-first — the Admin Dashboard's own version-history view. */
  async listVersions(graphId) {
    const { rows } = await pool.query(
      'SELECT * FROM graph_versions WHERE graph_id = $1 ORDER BY version_number DESC',
      [graphId],
    );
    return rows.map(graphVersionRowToModel);
  },

  /** One specific saved version, or null if this graph never had one with that number. */
  async getVersion(graphId, versionNumber) {
    const { rows } = await pool.query(
      'SELECT * FROM graph_versions WHERE graph_id = $1 AND version_number = $2',
      [graphId, versionNumber],
    );
    return rows[0] ? graphVersionRowToModel(rows[0]) : null;
  },

  /**
   * Restores a graph's live metadata+geometry to a prior saved version —
   * archives the current (about-to-be-overwritten) state first via
   * recordVersion (change_reason: 'restore'), exactly like repairGraph
   * does, so a restore is itself always undoable. Returns the restored
   * graph's model, or null if either the graph or that version number
   * doesn't exist.
   */
  async restoreVersion(graphId, versionNumber, { changedByUserId = null } = {}) {
    const version = await this.getVersion(graphId, versionNumber);
    if (!version) return null;
    await this.recordVersion(graphId, { changeReason: 'restore', changedByUserId });
    await pool.query(
      `UPDATE graphs SET title = $2, tags = $3, notes = $4, graph_color_hex = $5, visibility = $6, favorite = $7, updated_at = now() WHERE id = $1`,
      [graphId, version.title, version.tags, version.notes, version.graphColorHex, version.visibility, version.favorite],
    );
    await pool.query(
      `UPDATE graph_geometry SET points = $2, point_count = $3, status = $4, updated_at = now() WHERE graph_id = $1`,
      [graphId, JSON.stringify(version.points), version.pointCount, GRAPH_STATUS.EXACT],
    );
    return this.findById(graphId);
  },

  /**
   * Data-integrity-only repair: reconciles graph_geometry's stored
   * point_count/status with its own actual points array — the same
   * inconsistency findCorruptedGraphs detects. Deliberately never invokes
   * the plotting/geometry engine (src/anglePlot/**) to recompute points —
   * that would cross the "do not touch plotting/geometry logic" line this
   * whole Admin Dashboard phase is scoped to stay on the correct side of.
   * Archives the pre-repair state first via recordVersion.
   */
  async repairGraph(graphId, { changedByUserId = null } = {}) {
    const graph = await this.findById(graphId);
    if (!graph) return { repaired: false, reason: 'graph not found' };
    const { rows } = await pool.query('SELECT * FROM graph_geometry WHERE graph_id = $1', [graphId]);
    const geomRow = rows[0];
    if (!geomRow) return { repaired: false, reason: 'no geometry to repair' };

    const actualPointCount = Array.isArray(geomRow.points) ? geomRow.points.length : 0;
    const correctedStatus = actualPointCount > 0 ? GRAPH_STATUS.EXACT : geomRow.status;
    const needsFix = geomRow.point_count !== actualPointCount || geomRow.status !== correctedStatus;
    if (!needsFix) return { repaired: false, reason: 'already consistent' };

    await this.recordVersion(graphId, { changeReason: 'admin_repair', changedByUserId });
    const { rows: updated } = await pool.query(
      'UPDATE graph_geometry SET point_count = $2, status = $3, updated_at = now() WHERE graph_id = $1 RETURNING *',
      [graphId, actualPointCount, correctedStatus],
    );
    return { repaired: true, geometry: geometryRowToModel(updated[0]) };
  },
});

let sharedRepository = null;

/** The repository bound to the real shared pool (server/db/pool.js). Lazy, since obtaining the pool is async. */
export const getGraphRepository = async () => {
  if (!sharedRepository) sharedRepository = createGraphRepository(await getPool());
  return sharedRepository;
};
