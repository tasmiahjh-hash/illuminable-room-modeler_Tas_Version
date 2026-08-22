import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../server/api/app.js';
import { signToken } from '../server/auth/tokens.js';

// Real HTTP round trips (an ephemeral server), fake data underneath — same
// pattern as tests/workspace-routes.test.mjs.
process.env.JWT_SECRET = 'test-secret-never-used-outside-this-suite';

const USER_A = { id: 'user-a', email: 'a@example.com', displayName: 'Tasmiya Hasan', role: 'research_user', tokenVersion: 0 };
const USER_B = { id: 'user-b', email: 'b@example.com', displayName: 'Nick Shan', role: 'research_user', tokenVersion: 0 };

const authHeader = (user) => (user ? { Authorization: `Bearer ${signToken(user)}` } : {});

const createFakeAutosaveRepository = (overrides = {}) => ({
  getAutosave: async () => null,
  upsertAutosave: async ({ workspaceData, clientRevision }) => ({
    applied: true, autosave: { ownerUserId: 'whoever-called-it', workspaceData, clientRevision, updatedAt: 'now' },
  }),
  ...overrides,
});

const createFakeUserRepository = (overrides = {}) => ({
  findById: async (id) => [USER_A, USER_B].find((u) => u.id === id) ?? null,
  findByEmail: async () => null,
  bumpTokenVersion: async () => {},
  touchLastLogin: async () => {},
  ...overrides,
});

const startTestServer = ({ workspaceAutosaveRepository, userRepository } = {}) => {
  const server = http.createServer(createApp({}, {
    userRepository: userRepository ?? createFakeUserRepository(),
    workspaceAutosaveRepository: workspaceAutosaveRepository ?? createFakeAutosaveRepository(),
  }));
  return new Promise((resolve) => server.listen(0, () => {
    const { port } = server.address();
    resolve({ server, baseUrl: `http://localhost:${port}` });
  }));
};

const call = (baseUrl, method, path, { user, body } = {}) => fetch(`${baseUrl}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...authHeader(user) },
  body: body ? JSON.stringify(body) : undefined,
});

test('GET /api/workspace-autosave returns 401 without auth', async () => {
  const { server, baseUrl } = await startTestServer();
  const res = await call(baseUrl, 'GET', '/api/workspace-autosave');
  assert.equal(res.status, 401);
  server.close();
});

test('PUT /api/workspace-autosave returns 401 without auth', async () => {
  const { server, baseUrl } = await startTestServer();
  const res = await call(baseUrl, 'PUT', '/api/workspace-autosave', { body: { workspaceData: {}, clientRevision: 1 } });
  assert.equal(res.status, 401);
  server.close();
});

test('GET /api/workspace-autosave returns this user\'s own autosave, scoped by the session (never a param)', async () => {
  let receivedUserId;
  const repo = createFakeAutosaveRepository({
    getAutosave: async (userId) => { receivedUserId = userId; return { ownerUserId: userId, workspaceData: { sequences: [] }, clientRevision: 3, updatedAt: 'x' }; },
  });
  const { server, baseUrl } = await startTestServer({ workspaceAutosaveRepository: repo });
  const res = await call(baseUrl, 'GET', '/api/workspace-autosave', { user: USER_A });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(receivedUserId, USER_A.id);
  assert.equal(body.autosave.clientRevision, 3);
  server.close();
});

test('GET /api/workspace-autosave returns { autosave: null } when the user has never saved one', async () => {
  const { server, baseUrl } = await startTestServer();
  const res = await call(baseUrl, 'GET', '/api/workspace-autosave', { user: USER_A });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.autosave, null);
  server.close();
});

test('PUT /api/workspace-autosave stamps ownerUserId from the session, never a client-supplied one', async () => {
  let receivedArgs;
  const repo = createFakeAutosaveRepository({
    upsertAutosave: async (args) => { receivedArgs = args; return { applied: true, autosave: { ...args, updatedAt: 'x' } }; },
  });
  const { server, baseUrl } = await startTestServer({ workspaceAutosaveRepository: repo });
  const res = await call(baseUrl, 'PUT', '/api/workspace-autosave', {
    user: USER_A, body: { workspaceData: { sequences: [{ id: 's1' }] }, clientRevision: 4, ownerUserId: 'someone-else' },
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(receivedArgs.ownerUserId, USER_A.id);
  assert.equal(receivedArgs.clientRevision, 4);
  assert.deepEqual(receivedArgs.workspaceData, { sequences: [{ id: 's1' }] });
  assert.equal(body.applied, true);
  server.close();
});

test('PUT /api/workspace-autosave surfaces applied:false (not an HTTP error) when the write was rejected as stale', async () => {
  const repo = createFakeAutosaveRepository({
    upsertAutosave: async () => ({ applied: false, autosave: { ownerUserId: USER_A.id, workspaceData: { sequences: [{ id: 'newer' }] }, clientRevision: 9, updatedAt: 'x' } }),
  });
  const { server, baseUrl } = await startTestServer({ workspaceAutosaveRepository: repo });
  const res = await call(baseUrl, 'PUT', '/api/workspace-autosave', { user: USER_A, body: { workspaceData: {}, clientRevision: 2 } });
  const body = await res.json();
  assert.equal(res.status, 200, 'a stale write is a normal outcome, not an HTTP error');
  assert.equal(body.applied, false);
  assert.equal(body.autosave.clientRevision, 9);
  server.close();
});

test('PUT /api/workspace-autosave rejects a missing workspaceData with 400', async () => {
  const { server, baseUrl } = await startTestServer();
  const res = await call(baseUrl, 'PUT', '/api/workspace-autosave', { user: USER_A, body: { clientRevision: 1 } });
  assert.equal(res.status, 400);
  server.close();
});

test('PUT /api/workspace-autosave rejects a missing/negative clientRevision with 400', async () => {
  const { server, baseUrl } = await startTestServer();
  const res1 = await call(baseUrl, 'PUT', '/api/workspace-autosave', { user: USER_A, body: { workspaceData: {} } });
  assert.equal(res1.status, 400);
  const res2 = await call(baseUrl, 'PUT', '/api/workspace-autosave', { user: USER_A, body: { workspaceData: {}, clientRevision: -1 } });
  assert.equal(res2.status, 400);
  server.close();
});

test('two different users get independent autosaves — User B can never read or affect User A\'s', async () => {
  const store = new Map();
  const repo = createFakeAutosaveRepository({
    getAutosave: async (userId) => store.get(userId) ?? null,
    upsertAutosave: async ({ ownerUserId, workspaceData, clientRevision }) => {
      const autosave = { ownerUserId, workspaceData, clientRevision, updatedAt: 'x' };
      store.set(ownerUserId, autosave);
      return { applied: true, autosave };
    },
  });
  const { server, baseUrl } = await startTestServer({ workspaceAutosaveRepository: repo });

  await call(baseUrl, 'PUT', '/api/workspace-autosave', { user: USER_A, body: { workspaceData: { sequences: [{ id: 'a-only' }] }, clientRevision: 1 } });
  await call(baseUrl, 'PUT', '/api/workspace-autosave', { user: USER_B, body: { workspaceData: { sequences: [{ id: 'b-only' }] }, clientRevision: 1 } });

  const aRes = await call(baseUrl, 'GET', '/api/workspace-autosave', { user: USER_A });
  const bRes = await call(baseUrl, 'GET', '/api/workspace-autosave', { user: USER_B });
  const aBody = await aRes.json();
  const bBody = await bRes.json();

  assert.deepEqual(aBody.autosave.workspaceData, { sequences: [{ id: 'a-only' }] });
  assert.deepEqual(bBody.autosave.workspaceData, { sequences: [{ id: 'b-only' }] });
  server.close();
});
