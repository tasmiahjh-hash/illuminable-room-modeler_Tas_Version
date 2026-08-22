// WorkspaceSnapshotRepository: the ONLY module allowed to execute SQL
// against `workspace_snapshots` — mirrors graphRepository.js/
// userRepository.js's own hard rule and factory pattern (see
// graphRepository.js's own module comment for the full rationale).
//
// Backs the Cloud Workspace Library: "Save All" (createSnapshot),
// "Load Saved Work" (listSnapshots for the metadata-only browse list,
// getSnapshotById for the one full payload a Load actually needs), and
// delete (deleteSnapshot, owner- or admin-scoped — see adminRoutes.js's
// own precedent for what "admin bypasses ownership" looks like elsewhere
// in this codebase).

import { getPool } from '../db/pool.js';

const snapshotMetadataRowToModel = (row) => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  ownerDisplayName: row.owner_display_name,
  title: row.title,
  graphCount: row.graph_count,
  createdAt: row.created_at,
});

const snapshotRowToModel = (row) => ({
  ...snapshotMetadataRowToModel(row),
  workspaceData: row.workspace_data,
});

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** Builds a WorkspaceSnapshotRepository bound to `pool` (a real pg.Pool, or a fake for tests). */
export const createWorkspaceSnapshotRepository = (pool) => ({
  /**
   * Creates a new, immutable snapshot — every "Save All" click is a new
   * row, never an update (see this table's own migration comment on why
   * there's no updated_at). `ownerUserId`/`ownerDisplayName` must come
   * from the caller's own authenticated session (see workspaceRoutes.js),
   * never trusted from a request body.
   */
  async createSnapshot({ ownerUserId, ownerDisplayName, title, workspaceData, graphCount }) {
    const { rows } = await pool.query(
      `INSERT INTO workspace_snapshots (owner_user_id, owner_display_name, title, workspace_data, graph_count)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [ownerUserId, ownerDisplayName, title || null, JSON.stringify(workspaceData), graphCount],
    );
    return snapshotMetadataRowToModel(rows[0]);
  },

  /**
   * Metadata-only listing (never workspace_data — see this file's own
   * module comment on why a browse view must never ship every user's
   * full, potentially huge JSONB blob just to render a list). Every
   * authenticated user can list every other user's snapshots — read
   * access across owners is intentional (this is a shared library), only
   * write/delete are ownership-scoped (see deleteSnapshot).
   *
   * @param {object} [options]
   * @param {string} [options.search] - matches owner_display_name OR title (ILIKE).
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   */
  async listSnapshots({ search, limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      clauses.push(`(owner_display_name ILIKE $${params.length} OR title ILIKE $${params.length})`);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const { rows } = await pool.query(
      `SELECT id, owner_user_id, owner_display_name, title, graph_count, created_at
       FROM workspace_snapshots
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, safeLimit, safeOffset],
    );
    return rows.map(snapshotMetadataRowToModel);
  },

  /** One full snapshot (including workspace_data) by id — the one call Load actually needs. Readable by any authenticated user; null if no snapshot has this id. */
  async getSnapshotById(id) {
    const { rows } = await pool.query('SELECT * FROM workspace_snapshots WHERE id = $1', [id]);
    return rows[0] ? snapshotRowToModel(rows[0]) : null;
  },

  /**
   * Deletes a snapshot — the caller (workspaceRoutes.js) only invokes
   * this after confirming the requester either owns it or is an admin;
   * this method itself always scopes to `id` alone so it stays a single,
   * simple statement, mirroring findById-then-act elsewhere in this
   * codebase (e.g. graphRepository.js's own softDeleteGraph).
   * @returns {Promise<boolean>} whether a row actually existed to delete.
   */
  async deleteSnapshot(id) {
    const { rows } = await pool.query('DELETE FROM workspace_snapshots WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  },
});

let sharedRepository = null;

/** The repository bound to the real shared pool (server/db/pool.js). Lazy, since obtaining the pool is async. */
export const getWorkspaceSnapshotRepository = async () => {
  if (!sharedRepository) sharedRepository = createWorkspaceSnapshotRepository(await getPool());
  return sharedRepository;
};
