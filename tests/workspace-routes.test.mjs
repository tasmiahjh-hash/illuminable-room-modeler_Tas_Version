import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../server/api/app.js';
import { signToken } from '../server/auth/tokens.js';

// Real HTTP round trips (an ephemeral server), fake data underneath — same
// pattern as tests/api-app.test.mjs / tests/admin-routes.test.mjs.
process.env.JWT_SECRET = 'test-secret-never-used-outside-this-suite';

const ADMIN_USER = { id: 'admin-1', email: 'admin@example.com', displayName: 'Professor', role: 'admin', tokenVersion: 0 };
const USER_A = { id: 'user-a', email: 'a@example.com', displayName: 'Tasmiya Hasan', role: 'research_user', tokenVersion: 0 };
const USER_B = { id: 'user-b', email: 'b@example.com', displayName: 'Nick Shan', role: 'research_user', tokenVersion: 0 };

const authHeader = (user) => (user ? { Authorization: `Bearer ${signToken(user)}` } : {});

const SNAPSHOT_META = {
  id: 'snap-1', ownerUserId: USER_A.id, ownerDisplayName: 'Tasmiya Hasan',
  title: 'Testing long ABC sequences', graphCount: 88, createdAt: '2026-08-22T15:42:00.000Z',
};

const createFakeSnapshotRepository = (overrides = {}) => ({
  createSnapshot: async (args) => ({ id: 'snap-new', ...args, workspaceData: undefined }),
  listSnapshots: async () => [SNAPSHOT_META],
  getSnapshotById: async () => ({ ...SNAPSHOT_META, workspaceData: { sequences: [{ id: 'seq-1' }] } }),
  deleteSnapshot: async () => true,
  ...overrides,
});

const createFakeUserRepository = (overrides = {}) => ({
  findById: async (id) => [ADMIN_USER, USER_A, USER_B].find((u) => u.id === id) ?? null,
  findByEmail: async () => null,
  bumpTokenVersion: async () => {},
  touchLastLogin: async () => {},
  ...overrides,
});

const startTestServer = ({ workspaceSnapshotRepository, userRepository } = {}) => {
  const server = http.createServer(createApp({}, {
    userRepository: userRepository ?? createFakeUserRepository(),
    workspaceSnapshotRepository: workspaceSnapshotRepository ?? createFakeSnapshotRepository(),
  }));
  return new Promise((resolve) => server.listen(0, () => {
    const { port } = server.address();
    resolve({ server, baseUrl: `http://localhost:${port}` });
  }));
};

test('POST /api/workspaces returns 401 without auth', async () => {
  const { server, baseUrl } = await startTestServer();
  const res = await fetch(`${baseUrl}/api/workspaces`, { method: 'POST' });
  assert.equal(res.status, 401);
  server.close();
});

test('POST /api/workspaces creates a snapshot stamped with the authenticated session\'s own userId/displayName, never a client-supplied one', async () => {
  let receivedArgs;
  const repo = createFakeSnapshotRepository({ createSnapshot: async (args) => { receivedArgs = args; return { id: 'snap-new' }; } });
  const { server, baseUrl } = await startTestServer({ workspaceSnapshotRepository: repo });

  const res = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader(USER_A) },
    body: JSON.stringify({
      title: 'My Save', workspaceData: { sequences: [{ id: 'seq-1' }, { id: 'seq-2' }] },
      ownerUserId: 'someone-else', ownerDisplayName: 'Not Me',
    }),
  });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.deepEqual(body, { snapshot: { id: 'snap-new' } });
  assert.equal(receivedArgs.ownerUserId, USER_A.id, 'ownership must come from the session, never the request body');
  assert.equal(receivedArgs.ownerDisplayName, 'Tasmiya Hasan');
  assert.equal(receivedArgs.title, 'My Save');
  assert.equal(receivedArgs.graphCount, 2, 'graphCount is derived from workspaceData.sequences.length server-side');
  server.close();
});

test('POST /api/workspaces defaults title to an empty string when omitted (optional, never forced)', async () => {
  let receivedArgs;
  const repo = createFakeSnapshotRepository({ createSnapshot: async (args) => { receivedArgs = args; return { id: 'snap-new' }; } });
  const { server, baseUrl } = await startTestServer({ workspaceSnapshotRepository: repo });
  await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader(USER_A) },
    body: JSON.stringify({ workspaceData: { sequences: [] } }),
  });
  assert.equal(receivedArgs.title, '');
  server.close();
});

test('POST /api/workspaces rejects a missing workspaceData with 400, never touching the repository', async () => {
  let called = false;
  const repo = createFakeSnapshotRepository({ createSnapshot: async () => { called = true; } });
  const { server, baseUrl } = await startTestServer({ workspaceSnapshotRepository: repo });
  const res = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader(USER_A) }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.equal(called, false);
  server.close();
});

test('GET /api/workspaces returns 401 without auth', async () => {
  const { server, baseUrl } = await startTestServer();
  const res = await fetch(`${baseUrl}/api/workspaces`);
  assert.equal(res.status, 401);
  server.close();
});

test('GET /api/workspaces lists metadata for every user (User B can see User A\'s snapshots)', async () => {
  const { server, baseUrl } = await startTestServer();
  const res = await fetch(`${baseUrl}/api/workspaces`, { headers: authHeader(USER_B) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.snapshots, [SNAPSHOT_META]);
  server.close();
});

test('GET /api/workspaces passes q/limit/offset through to the repository', async () => {
  let receivedOptions;
  const repo = createFakeSnapshotRepository({ listSnapshots: async (options) => { receivedOptions = options; return []; } });
  const { server, baseUrl } = await startTestServer({ workspaceSnapshotRepository: repo });
  await fetch(`${baseUrl}/api/workspaces?q=Tasmiya&limit=10&offset=5`, { headers: authHeader(USER_A) });
  assert.deepEqual(receivedOptions, { search: 'Tasmiya', limit: 10, offset: 5 });
  server.close();
});

test('GET /api/workspaces/:id returns the full snapshot (including workspaceData) for Load, regardless of ownership', async () => {
  const { server, baseUrl } = await startTestServer();
  const res = await fetch(`${baseUrl}/api/workspaces/snap-1`, { headers: authHeader(USER_B) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.snapshot.workspaceData, { sequences: [{ id: 'seq-1' }] });
  server.close();
});

test('GET /api/workspaces/:id returns 404 for an unknown id', async () => {
  const repo = createFakeSnapshotRepository({ getSnapshotById: async () => null });
  const { server, baseUrl } = await startTestServer({ workspaceSnapshotRepository: repo });
  const res = await fetch(`${baseUrl}/api/workspaces/missing`, { headers: authHeader(USER_A) });
  assert.equal(res.status, 404);
  server.close();
});

test('DELETE /api/workspaces/:id lets the owner delete their own snapshot', async () => {
  let deletedId;
  const repo = createFakeSnapshotRepository({ deleteSnapshot: async (id) => { deletedId = id; return true; } });
  const { server, baseUrl } = await startTestServer({ workspaceSnapshotRepository: repo });
  const res = await fetch(`${baseUrl}/api/workspaces/snap-1`, { method: 'DELETE', headers: authHeader(USER_A) });
  assert.equal(res.status, 200);
  assert.equal(deletedId, 'snap-1');
  server.close();
});

test('DELETE /api/workspaces/:id returns 403 for a different research_user (never transfers delete permission just from loading it)', async () => {
  let called = false;
  const repo = createFakeSnapshotRepository({ deleteSnapshot: async () => { called = true; return true; } });
  const { server, baseUrl } = await startTestServer({ workspaceSnapshotRepository: repo });
  const res = await fetch(`${baseUrl}/api/workspaces/snap-1`, { method: 'DELETE', headers: authHeader(USER_B) });
  assert.equal(res.status, 403);
  assert.equal(called, false);
  server.close();
});

test('DELETE /api/workspaces/:id lets an admin delete any user\'s snapshot', async () => {
  let deletedId;
  const repo = createFakeSnapshotRepository({ deleteSnapshot: async (id) => { deletedId = id; return true; } });
  const { server, baseUrl } = await startTestServer({ workspaceSnapshotRepository: repo });
  const res = await fetch(`${baseUrl}/api/workspaces/snap-1`, { method: 'DELETE', headers: authHeader(ADMIN_USER) });
  assert.equal(res.status, 200);
  assert.equal(deletedId, 'snap-1');
  server.close();
});

test('DELETE /api/workspaces/:id returns 404 for an unknown id', async () => {
  const repo = createFakeSnapshotRepository({ getSnapshotById: async () => null });
  const { server, baseUrl } = await startTestServer({ workspaceSnapshotRepository: repo });
  const res = await fetch(`${baseUrl}/api/workspaces/missing`, { method: 'DELETE', headers: authHeader(USER_A) });
  assert.equal(res.status, 404);
  server.close();
});
