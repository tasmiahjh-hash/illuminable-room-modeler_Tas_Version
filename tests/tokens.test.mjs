import assert from 'node:assert/strict';
import test from 'node:test';

// JWT_SECRET must be set before signToken/verifyToken are ever called (see
// tokens.js's own getSecret) — set here, at module load, before the import
// below runs any of this file's tests.
process.env.JWT_SECRET = 'test-secret-never-used-outside-this-suite';

const { signToken, verifyToken } = await import('../server/auth/tokens.js');

const USER = { id: 'user-1', role: 'research_user', tokenVersion: 0 };

test('signToken produces a token verifyToken can decode back to the same claims', () => {
  const token = signToken(USER);
  const claims = verifyToken(token);
  assert.deepEqual(claims, { userId: 'user-1', role: 'research_user', tokenVersion: 0 });
});

test('verifyToken returns null for a malformed token', () => {
  assert.equal(verifyToken('not-a-real-token'), null);
});

test('verifyToken returns null for a token signed with a different secret', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const foreignToken = jwt.sign({ sub: 'user-1', role: 'research_user', tokenVersion: 0 }, 'a-different-secret');
  assert.equal(verifyToken(foreignToken), null);
});

test('verifyToken returns null for an expired token', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const expiredToken = jwt.sign(
    { sub: 'user-1', role: 'research_user', tokenVersion: 0 },
    process.env.JWT_SECRET,
    { expiresIn: -1 }, // already expired the instant it's issued
  );
  assert.equal(verifyToken(expiredToken), null);
});

test('signToken embeds role and tokenVersion so a role/logout change is checkable without a second field', () => {
  const adminToken = signToken({ id: 'admin-1', role: 'admin', tokenVersion: 2 });
  assert.deepEqual(verifyToken(adminToken), { userId: 'admin-1', role: 'admin', tokenVersion: 2 });
});
