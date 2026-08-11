import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = 'test-secret-never-used-outside-this-suite';

const { signToken } = await import('../server/auth/tokens.js');
const { resolveAuthContext, hasRole } = await import('../server/auth/requireAuth.js');

const USER = { id: 'user-1', email: 'researcher@example.com', displayName: 'Test Researcher', role: 'research_user', tokenVersion: 0 };

// A fake request object — resolveAuthContext only ever reads req.headers.authorization.
const fakeRequest = (authorizationHeader) => ({ headers: authorizationHeader ? { authorization: authorizationHeader } : {} });

const fakeUserRepository = (users) => ({
  findById: async (id) => users.find((u) => u.id === id) ?? null,
});

test('resolveAuthContext returns null when there is no Authorization header', async () => {
  const repo = fakeUserRepository([USER]);
  assert.equal(await resolveAuthContext(fakeRequest(undefined), { userRepository: repo }), null);
});

test('resolveAuthContext returns null for a header that isn\'t "Bearer <token>"', async () => {
  const repo = fakeUserRepository([USER]);
  assert.equal(await resolveAuthContext(fakeRequest('Basic abc123'), { userRepository: repo }), null);
});

test('resolveAuthContext returns null for "Bearer" with no token', async () => {
  const repo = fakeUserRepository([USER]);
  assert.equal(await resolveAuthContext(fakeRequest('Bearer '), { userRepository: repo }), null);
});

test('resolveAuthContext returns null for a malformed token', async () => {
  const repo = fakeUserRepository([USER]);
  assert.equal(await resolveAuthContext(fakeRequest('Bearer not-a-real-token'), { userRepository: repo }), null);
});

test('resolveAuthContext returns the auth context for a valid token whose user still exists with a matching tokenVersion', async () => {
  const repo = fakeUserRepository([USER]);
  const token = signToken(USER);
  const context = await resolveAuthContext(fakeRequest(`Bearer ${token}`), { userRepository: repo });
  assert.deepEqual(context, { userId: 'user-1', role: 'research_user', email: 'researcher@example.com', displayName: 'Test Researcher' });
});

test('resolveAuthContext returns null when the token\'s user no longer exists (deleted account)', async () => {
  const repo = fakeUserRepository([]); // no users at all
  const token = signToken(USER);
  assert.equal(await resolveAuthContext(fakeRequest(`Bearer ${token}`), { userRepository: repo }), null);
});

test('resolveAuthContext returns null when tokenVersion no longer matches (logged out / revoked)', async () => {
  const token = signToken(USER); // signed with tokenVersion: 0
  const repo = fakeUserRepository([{ ...USER, tokenVersion: 1 }]); // but the account has since bumped to 1
  assert.equal(await resolveAuthContext(fakeRequest(`Bearer ${token}`), { userRepository: repo }), null);
});

test('hasRole matches the resolved context\'s own role', () => {
  assert.equal(hasRole({ role: 'admin' }, 'admin'), true);
  assert.equal(hasRole({ role: 'research_user' }, 'admin'), false);
});

test('hasRole returns false for a null context (unauthenticated)', () => {
  assert.equal(hasRole(null, 'admin'), false);
});
