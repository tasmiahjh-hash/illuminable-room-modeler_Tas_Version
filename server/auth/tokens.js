// JWT sign/verify — the app's whole session mechanism (see the RDS plan's
// own architecture-decision note on why JWT-in-a-header over cookies: the
// frontend and this API are different origins in production, and a
// cookie-based session would force SameSite=None + credentialed CORS,
// which is a fragile coupling to introduce for this feature). Pure
// functions plus one env var read — no database access here at all;
// token_version *comparison* (the revocation check) happens in
// requireAuth.js, which is the one place a verified token's claims meet a
// fresh database read.

import jwt from 'jsonwebtoken';

// "Stay signed in" (confirmed decision — token persists in the browser
// across restarts) still needs a hard ceiling: an indefinitely-valid token
// that leaked once would never expire. 30 days balances "a researcher
// doesn't have to sign in every session" against "a leaked/old token stops
// working on its own within a bounded window" — token_version gives
// immediate revocation (logout) independent of this expiry.
const TOKEN_EXPIRY = '30d';

// Read lazily (not at module load) so importing this file never requires
// JWT_SECRET to be set — only actually signing/verifying a token does,
// matching db/pool.js's own "lazy, so tests/tooling can import without full
// env config" pattern. Throws rather than falling back to any default
// value: a guessable/shared default secret would let anyone forge a valid
// token for any user, which is a strictly worse failure mode than this
// route simply not working until the operator sets it.
const getSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is not set');
  return secret;
};

/**
 * Signs a token for `user` ({id, role, tokenVersion} — see
 * userRepository.js's own auth-internal shape). The token embeds exactly
 * what requireAuth needs to authorize a later request without a database
 * read for the common case (userId, role) plus tokenVersion, whose only
 * job is to be compared against the database's current value so a bumped
 * tokenVersion (logout) invalidates every token issued before it.
 */
export const signToken = (user) => jwt.sign(
  { sub: user.id, role: user.role, tokenVersion: user.tokenVersion },
  getSecret(),
  { expiresIn: TOKEN_EXPIRY },
);

/**
 * Verifies a token's signature and expiry. Returns
 * `{userId, role, tokenVersion} | null` — null for any failure (expired,
 * malformed, wrong signature), deliberately not distinguishing which, so
 * callers can't be tempted to treat "expired" as more trustworthy than
 * "forged." requireAuth.js is the one place that turns this into an HTTP
 * 401 and, separately, checks tokenVersion against the database.
 */
export const verifyToken = (token) => {
  try {
    const payload = jwt.verify(token, getSecret());
    return { userId: payload.sub, role: payload.role, tokenVersion: payload.tokenVersion };
  } catch {
    return null;
  }
};
