// Auth-context resolution for a raw Node http request. Deliberately plain
// functions a route handler calls at the top of its own branch — not
// framework middleware — matching server/api/app.js's own "no framework"
// architecture (see that file's module comment). A route that needs auth
// calls resolveAuthContext itself and decides what to do with a null
// result (401), exactly the same shape every other early-return validation
// in app.js already uses (e.g. "missing hash" -> 400).

import { verifyToken } from './tokens.js';
import { getUserRepository } from '../repositories/userRepository.js';

/**
 * Resolves `{userId, role, email, displayName} | null` for `req` — null
 * for a missing/malformed header, an invalid/expired token, a token whose
 * user no longer exists, or a token whose embedded tokenVersion no longer
 * matches the user's current one (logout/revocation — see tokens.js's own
 * comment on why that check lives here, against a fresh database read,
 * rather than being encodable in the token's signature alone).
 *
 * `userRepository` is injectable so tests never need a real database
 * connection (see tests/require-auth.test.mjs) — defaults to the real
 * shared repository otherwise.
 */
export const resolveAuthContext = async (req, { userRepository } = {}) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;

  const claims = verifyToken(token);
  if (!claims) return null;

  const repo = userRepository ?? await getUserRepository();
  const user = await repo.findById(claims.userId);
  if (!user) return null;
  if (user.tokenVersion !== claims.tokenVersion) return null;

  return { userId: user.id, role: user.role, email: user.email, displayName: user.displayName };
};

/** Whether an auth context (from resolveAuthContext) has the given role. Null context never matches any role. */
export const hasRole = (authContext, role) => authContext?.role === role;
