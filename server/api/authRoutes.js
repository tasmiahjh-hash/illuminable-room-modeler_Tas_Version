// Auth routes: signup/login/logout/me. Kept in its own file rather than
// inline in app.js because RDS adds enough new route families (auth now,
// admin/sync/versions in later phases) that growing app.js's single
// if/else chain indefinitely would stop matching its own route-table
// comment. Same shape as every other route in this project: given
// (req, res, url), read the body if needed, call a repository, respond —
// no framework, no middleware chain (see app.js's own module comment for
// why). `handleAuthRoute` returns true if it matched and handled the
// request, false otherwise, so app.js's dispatcher can try it before its
// own inline routes and fall through cleanly when it doesn't match.

import { readJsonBody, sendJson } from './httpHelpers.js';
import { hashPassword, verifyPassword } from '../auth/passwordHashing.js';
import { signToken } from '../auth/tokens.js';
import { resolveAuthContext } from '../auth/requireAuth.js';
import { getUserRepository } from '../repositories/userRepository.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

/** Strips passwordHash/tokenVersion (userRepository's auth-internal fields) before a user record is ever sent to a client. */
const toPublicUser = (user) => {
  const { passwordHash, tokenVersion, ...publicUser } = user;
  return publicUser;
};

/**
 * Handles POST /api/auth/signup, POST /api/auth/login, POST /api/auth/logout,
 * GET /api/auth/me. Returns true if `url`/`req.method` matched one of
 * these (and the response has already been sent), false otherwise.
 *
 * `userRepository` is injectable (defaults to the real shared repository)
 * so tests exercise real HTTP round trips against a fake repository, no
 * database required — mirrors app.js's own `repository` parameter for the
 * graph routes (see tests/auth-routes.test.mjs).
 */
export const handleAuthRoute = async (req, res, url, { userRepository } = {}) => {
  // Bail out on pathname alone, before ever resolving a repository (real
  // or injected) — every request in this app passes through here first
  // (see app.js's dispatcher), so the vast majority never touch
  // /api/auth/* at all and must not pay for (or require) a database
  // connection just to be told "not my route."
  if (!url.pathname.startsWith('/api/auth/')) return false;

  const repo = userRepository ?? await getUserRepository();

  if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
    const body = await readJsonBody(req);
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName = (typeof body.displayName === 'string' ? body.displayName.trim() : '') || email.split('@')[0];

    if (!email || !EMAIL_PATTERN.test(email)) {
      sendJson(res, 400, { error: 'a valid email is required' });
      return true;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      sendJson(res, 400, { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return true;
    }
    if (await repo.findByEmail(email)) {
      sendJson(res, 409, { error: 'an account with this email already exists' });
      return true;
    }

    const passwordHash = await hashPassword(password);
    // Every account created through this route is a Research User —
    // Admin is never self-service (see the RDS spec's own role list; an
    // Admin account is granted by an existing Admin/direct DB action, a
    // later phase's own concern, not this signup route's).
    const user = await repo.createUser({ email, passwordHash, displayName, role: 'research_user' });
    // A freshly created row's token_version is always the migration's own
    // DEFAULT 0 — signing directly from that avoids a second round trip
    // back to the database purely to re-read what was just written.
    const token = signToken({ id: user.id, role: user.role, tokenVersion: 0 });
    sendJson(res, 201, { token, user });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJsonBody(req);
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      sendJson(res, 400, { error: 'email and password are required' });
      return true;
    }
    const user = await repo.findByEmail(email);
    // Same message whether the email doesn't exist or the password is
    // wrong — distinguishing the two would let an attacker enumerate
    // registered emails one guess at a time.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      sendJson(res, 401, { error: 'invalid email or password' });
      return true;
    }

    await repo.touchLastLogin(user.id);
    const token = signToken(user);
    sendJson(res, 200, { token, user: toPublicUser(user) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const auth = await resolveAuthContext(req, { userRepository: repo });
    if (!auth) {
      sendJson(res, 401, { error: 'not signed in' });
      return true;
    }
    // Bumping token_version is the entire logout mechanism for a stateless
    // JWT (see tokens.js's own comment) — this one token, and every other
    // token issued before it, stop being accepted immediately.
    await repo.bumpTokenVersion(auth.userId);
    sendJson(res, 200, { loggedOut: true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const auth = await resolveAuthContext(req, { userRepository: repo });
    if (!auth) {
      sendJson(res, 401, { error: 'not signed in' });
      return true;
    }
    // resolveAuthContext's own shape is {userId, role, email, displayName}
    // (userId matches every server-side auth.userId call site elsewhere in
    // this codebase) — but every client-side user object otherwise comes
    // from toPublicUser(user), which has `id`, not `userId`. Add `id` here
    // so a page reload's re-validated user matches the same shape a fresh
    // login/signup already returns; without it, code that reads
    // `auth.user.id` (e.g. AuthGate.jsx's signedInUserId) silently sees
    // undefined after every reload, even though the user IS signed in.
    sendJson(res, 200, { user: { ...auth, id: auth.userId } });
    return true;
  }

  return false;
};
