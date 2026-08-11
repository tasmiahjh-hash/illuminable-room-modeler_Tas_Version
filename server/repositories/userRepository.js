// UserRepository: the ONLY module allowed to execute SQL against the
// `users` table, mirroring graphRepository.js's own hard rule (see that
// file's module comment for the full rationale) and its exact factory
// pattern — createUserRepository(pool) rather than a bare singleton, so
// tests never need a real database connection (see
// tests/user-repository.test.mjs).
//
// findByEmail/findById return a superset shape that includes
// passwordHash/tokenVersion — fields userRowToModel deliberately excludes
// from the public model. These two methods exist only for auth's own
// internal use (login's password check, requireAuth's token-version
// check); callers must never forward their raw return value straight into
// an HTTP response — strip passwordHash/tokenVersion first (see
// server/api/authRoutes.js for the pattern).

import { getPool } from '../db/pool.js';
import { userRowToModel } from '../models/user.js';

const withAuthFields = (row) => ({
  ...userRowToModel(row),
  passwordHash: row.password_hash,
  tokenVersion: row.token_version,
});

/**
 * Builds a UserRepository bound to `pool` (anything with an async
 * `query(text, params)` — a real pg.Pool, or a fake for tests).
 */
export const createUserRepository = (pool) => ({
  /**
   * Creates a new research-user (or, if explicitly passed, admin) account.
   * `passwordHash` must already be hashed (see server/auth/passwordHashing.js) —
   * this repository never hashes/verifies passwords itself, exactly as it
   * never builds SQL outside this file.
   */
  async createUser({ email, passwordHash, displayName, role = 'research_user' }) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [email, passwordHash, displayName, role],
    );
    return userRowToModel(rows[0]);
  },

  /** The account with this email, including auth-internal fields, or null. Case-sensitive — callers normalize (lowercase) email before calling. */
  async findByEmail(email) {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] ? withAuthFields(rows[0]) : null;
  },

  /** The account with this id, including auth-internal fields, or null. */
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? withAuthFields(rows[0]) : null;
  },

  /**
   * Invalidates every JWT issued before now for this user (logout, or a
   * future "sign out everywhere"/password-change flow) — every request's
   * token carries the token_version it was signed with; requireAuth
   * rejects a token whose version no longer matches this column.
   */
  async bumpTokenVersion(id) {
    await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [id]);
  },

  /** Records a successful sign-in — display-only bookkeeping (Admin Dashboard's future "Last Sync"/activity views), never used for authorization. */
  async touchLastLogin(id) {
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
  },
});

let sharedRepository = null;

/** The repository bound to the real shared pool (server/db/pool.js). Lazy, since obtaining the pool is async. */
export const getUserRepository = async () => {
  if (!sharedRepository) sharedRepository = createUserRepository(await getPool());
  return sharedRepository;
};
