// User model: maps between a `users` table row (snake_case columns) and
// the plain domain shape the rest of the server works with. A pure
// mapping module — no I/O, no SQL — kept separate from userRepository.js
// so the *shape* of a user and the *queries* that produce it can change
// independently (mirrors server/models/graph.js's own split for graphs).
//
// password_hash is deliberately never included here — this is the shape
// returned to route handlers and, from there, serialized into HTTP
// responses; a field that must never leave the server has no business
// being on the one object every caller passes around.

/** @returns {{id, email, displayName, role, createdAt, lastLoginAt, lastSeenAt}} */
export const userRowToModel = (row) => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  role: row.role,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
  // Presence heuristic (migration 0012) — see userRepository.js's own
  // touchLastSeen comment. `undefined`-safe default so a row fetched
  // before that migration ran still maps to a valid model.
  lastSeenAt: row.last_seen_at ?? null,
});
