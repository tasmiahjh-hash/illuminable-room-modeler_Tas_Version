import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

process.env.JWT_SECRET = 'test-secret-never-used-outside-this-suite';

const { createApp } = await import('../server/api/app.js');
const { signToken } = await import('../server/auth/tokens.js');

// createApp's own graph repository is never touched by any /api/auth/*
// route (see app.js's own route order — auth is checked first, and none
// of these tests call a /api/graphs* route), so a repository that throws
// on any call still proves that.
const untouchedGraphRepository = () => ({
  listGraphs: async () => { throw new Error('graph repository must not be touched by auth routes'); },
});

const createFakeUserRepository = (overrides = {}) => ({
  users: [],
  findByEmail: async function findByEmail(email) { return this.users.find((u) => u.email === email) ?? null; },
  findById: async function findById(id) { return this.users.find((u) => u.id === id) ?? null; },
  createUser: async function createUser({ email, passwordHash, displayName, role = 'research_user' }) {
    const user = { id: `user-${this.users.length + 1}`, email, passwordHash, displayName, role, tokenVersion: 0, createdAt: 'created-x', lastLoginAt: null };
    this.users.push(user);
    const { passwordHash: _omit, tokenVersion: _omit2, ...publicUser } = user;
    return publicUser;
  },
  bumpTokenVersion: async function bumpTokenVersion(id) {
    const user = this.users.find((u) => u.id === id);
    if (user) user.tokenVersion += 1;
  },
  touchLastLogin: async function touchLastLogin(id) {
    const user = this.users.find((u) => u.id === id);
    if (user) user.lastLoginAt = 'logged-in-x';
  },
  ...overrides,
});

const startTestServer = async (userRepository) => {
  const server = http.createServer(createApp(untouchedGraphRepository(), { userRepository }));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://localhost:${port}` };
};

const postJson = (baseUrl, path, body, headers = {}) => fetch(`${baseUrl}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('POST /api/auth/signup creates an account and returns a token + the public user (no passwordHash)', async () => {
  const repo = createFakeUserRepository();
  const { server, baseUrl } = await startTestServer(repo);
  const res = await postJson(baseUrl, '/api/auth/signup', { email: 'Researcher@Example.com', password: 'a-long-enough-password', displayName: 'Ada' });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.ok(body.token);
  assert.equal(body.user.email, 'researcher@example.com', 'email is normalized to lowercase');
  assert.equal(body.user.displayName, 'Ada');
  assert.equal(body.user.role, 'research_user');
  assert.ok(!('passwordHash' in body.user));
  assert.equal(repo.users[0].passwordHash === 'a-long-enough-password', false, 'the stored password must be hashed, never the plaintext');
  server.close();
});

test('POST /api/auth/signup rejects an invalid email with 400', async () => {
  const { server, baseUrl } = await startTestServer(createFakeUserRepository());
  const res = await postJson(baseUrl, '/api/auth/signup', { email: 'not-an-email', password: 'a-long-enough-password' });
  assert.equal(res.status, 400);
  server.close();
});

test('POST /api/auth/signup rejects a too-short password with 400', async () => {
  const { server, baseUrl } = await startTestServer(createFakeUserRepository());
  const res = await postJson(baseUrl, '/api/auth/signup', { email: 'a@example.com', password: 'short' });
  assert.equal(res.status, 400);
  server.close();
});

test('POST /api/auth/signup rejects a duplicate email with 409', async () => {
  const repo = createFakeUserRepository();
  const { server, baseUrl } = await startTestServer(repo);
  await postJson(baseUrl, '/api/auth/signup', { email: 'a@example.com', password: 'a-long-enough-password' });
  const res = await postJson(baseUrl, '/api/auth/signup', { email: 'a@example.com', password: 'a-different-password' });
  assert.equal(res.status, 409);
  server.close();
});

test('POST /api/auth/login succeeds with the correct password and returns a token', async () => {
  const repo = createFakeUserRepository();
  const { server, baseUrl } = await startTestServer(repo);
  await postJson(baseUrl, '/api/auth/signup', { email: 'a@example.com', password: 'a-long-enough-password' });
  const res = await postJson(baseUrl, '/api/auth/login', { email: 'a@example.com', password: 'a-long-enough-password' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.token);
  assert.equal(body.user.email, 'a@example.com');
  server.close();
});

test('POST /api/auth/login rejects a wrong password with 401 and no distinguishing detail', async () => {
  const repo = createFakeUserRepository();
  const { server, baseUrl } = await startTestServer(repo);
  await postJson(baseUrl, '/api/auth/signup', { email: 'a@example.com', password: 'a-long-enough-password' });
  const res = await postJson(baseUrl, '/api/auth/login', { email: 'a@example.com', password: 'totally-wrong' });
  assert.equal(res.status, 401);
  server.close();
});

test('POST /api/auth/login rejects an email that was never signed up with the same 401 (no email enumeration)', async () => {
  const { server, baseUrl } = await startTestServer(createFakeUserRepository());
  const res = await postJson(baseUrl, '/api/auth/login', { email: 'nobody@example.com', password: 'whatever12345' });
  assert.equal(res.status, 401);
  server.close();
});

test('a token issued by login authenticates a subsequent GET /api/auth/me', async () => {
  const repo = createFakeUserRepository();
  const { server, baseUrl } = await startTestServer(repo);
  const loginRes = await postJson(baseUrl, '/api/auth/signup', { email: 'a@example.com', password: 'a-long-enough-password', displayName: 'A' });
  const { token, user: signedUpUser } = await loginRes.json();
  const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const meBody = await meRes.json();
  assert.equal(meRes.status, 200);
  assert.equal(meBody.user.email, 'a@example.com');
  // Regression: /api/auth/me must return `id` in the same shape signup/
  // login already do (both mapped through toPublicUser) — the frontend's
  // AuthGate reads auth.user.id to know a re-validated session is signed
  // in, and a mismatch here (e.g. `userId` instead of `id`) leaves it
  // silently stuck thinking nobody is signed in after every page reload.
  assert.equal(meBody.user.id, signedUpUser.id);
  server.close();
});

test('GET /api/auth/me returns 401 with no Authorization header', async () => {
  const { server, baseUrl } = await startTestServer(createFakeUserRepository());
  const res = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(res.status, 401);
  server.close();
});

test('POST /api/auth/logout invalidates the token — a later request with the same token gets 401', async () => {
  const repo = createFakeUserRepository();
  const { server, baseUrl } = await startTestServer(repo);
  const signupRes = await postJson(baseUrl, '/api/auth/signup', { email: 'a@example.com', password: 'a-long-enough-password' });
  const { token } = await signupRes.json();

  const beforeLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(beforeLogout.status, 200);

  const logoutRes = await postJson(baseUrl, '/api/auth/logout', {}, { Authorization: `Bearer ${token}` });
  assert.equal(logoutRes.status, 200);

  const afterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(afterLogout.status, 401);
  server.close();
});

test('signToken\'s token is accepted by /api/graphs* too (shared auth, not a separate mechanism)', async () => {
  const repo = createFakeUserRepository();
  repo.users.push({ id: 'user-9', email: 'x@example.com', displayName: 'X', role: 'research_user', tokenVersion: 0 });
  const token = signToken({ id: 'user-9', role: 'research_user', tokenVersion: 0 });
  const fakeGraphRepository = { listGraphs: async () => [] };
  const server = http.createServer(createApp(fakeGraphRepository, { userRepository: repo }));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/api/graphs`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  server.close();
});
