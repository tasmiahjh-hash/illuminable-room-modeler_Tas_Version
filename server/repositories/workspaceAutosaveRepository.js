// WorkspaceAutosaveRepository: the ONLY module allowed to execute SQL
// against `workspace_autosaves` — mirrors workspaceSnapshotRepository.js's
// own factory pattern and hard "one file per table" rule (see
// graphRepository.js's own module comment for the full rationale).
//
// This backs Cloud Autosave: ONE continuously-updated row per account
// (never a history — that's workspace_snapshots/Save All's own job).
// Every write is a conditional UPSERT keyed on owner_user_id (the row's
// own primary key, since the relationship is inherently 1:1) — see
// upsertAutosave's own comment for how client_revision makes "an older
// request can never overwrite a newer state" an atomic, database-enforced
// guarantee rather than a best-effort ordering hope.

import { getPool } from '../db/pool.js';

const autosaveRowToModel = (row) => ({
  ownerUserId: row.owner_user_id,
  workspaceData: row.workspace_data,
  clientRevision: Number(row.client_revision),
  updatedAt: row.updated_at,
});

/** Builds a WorkspaceAutosaveRepository bound to `pool` (a real pg.Pool, or a fake for tests). */
export const createWorkspaceAutosaveRepository = (pool) => ({
  /**
   * The authenticated user's own current autosave, or null if they've
   * never saved one yet (a brand-new account, or one that's only ever
   * used Save All/never had this feature autosave anything).
   */
  async getAutosave(ownerUserId) {
    const { rows } = await pool.query('SELECT * FROM workspace_autosaves WHERE owner_user_id = $1', [ownerUserId]);
    return rows[0] ? autosaveRowToModel(rows[0]) : null;
  },

  /**
   * Creates or overwrites this user's one autosave row — but only when
   * `clientRevision` is at least as new as whatever's already stored.
   * `ON CONFLICT ... DO UPDATE ... WHERE` is a single atomic statement:
   * if the WHERE condition is false, Postgres applies neither the insert
   * (a conflict was detected) nor the update (the WHERE rejected it), and
   * RETURNING yields nothing for that row — no read-then-write race
   * window exists for a second, concurrent request to land in, unlike a
   * separate "SELECT current revision, then decide whether to UPDATE" pair
   * of queries would have.
   *
   * @returns {Promise<{applied: boolean, autosave: object|null}>}
   *   `applied: true` with the newly-stored row when the write went
   *   through; `applied: false` with the *current* (unchanged, still
   *   more-recent) row when this request's own clientRevision lost the
   *   race — the caller (workspaceAutosaveRoutes.js) reports this as a
   *   normal, non-error outcome, exactly the "stale write silently
   *   ignored" behavior this feature's own spec asks for.
   */
  async upsertAutosave({ ownerUserId, workspaceData, clientRevision }) {
    const { rows } = await pool.query(
      `INSERT INTO workspace_autosaves (owner_user_id, workspace_data, client_revision, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (owner_user_id) DO UPDATE
         SET workspace_data = EXCLUDED.workspace_data,
             client_revision = EXCLUDED.client_revision,
             updated_at = now()
         WHERE workspace_autosaves.client_revision <= EXCLUDED.client_revision
       RETURNING *`,
      [ownerUserId, JSON.stringify(workspaceData), clientRevision],
    );
    if (rows[0]) return { applied: true, autosave: autosaveRowToModel(rows[0]) };
    const current = await this.getAutosave(ownerUserId);
    return { applied: false, autosave: current };
  },
});

let sharedRepository = null;

/** The repository bound to the real shared pool (server/db/pool.js). Lazy, since obtaining the pool is async. */
export const getWorkspaceAutosaveRepository = async () => {
  if (!sharedRepository) sharedRepository = createWorkspaceAutosaveRepository(await getPool());
  return sharedRepository;
};
