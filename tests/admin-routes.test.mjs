import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../server/api/app.js';
import { signToken } from '../server/auth/tokens.js';

// Real HTTP round trips (an ephemeral server), fake data underneath — same
// pattern as tests/api-app.test.mjs's own createFakeRepository/
// createFakeUserRepository, just extended with the admin-only repository
// methods adminRoutes.js calls.
process.env.JWT_SECRET = 'test-secret-never-used-outside-this-suite';

const ADMIN_USER = { id: 'admin-1', email: 'admin@example.com', displayName: 'Test Admin', role: 'admin', tokenVersion: 0 };
const RESEARCH_USER = { id: 'user-1', email: 'researcher@example.com', displayName: 'Test Researcher', role: 'research_user', tokenVersion: 0 };
const OTHER_USER = { id: 'user-2', email: 'other@example.com', displayName: 'Other Researcher', role: 'research_user', tokenVersion: 0 };

const authHeader = (user) => (user ? { Authorization: `Bearer ${signToken(user)}` } : {});

const GRAPH = { id: 'graph-1', hash: 'hash-abc', ownerUserId: RESEARCH_USER.id, title: 'A Graph' };
const GEOMETRY = { id: 'geo-1', graphId: 'graph-1', points: [{ a: 1, b: 2 }], pointCount: 1 };

const createFakeRepository = (overrides = {}) => ({
  findById: async () => GRAPH,
  getGeometry: async () => GEOMETRY,
  queryGraphsAdmin: async () => [],
  findFailedJobs: async () => [],
  findCorruptedGraphs: async () => [],
  findDuplicateParameterSets: async () => [],
  softDeleteGraph: async () => ({ ...GRAPH, deletedAt: 'now' }),
  restoreGraph: async () => ({ ...GRAPH, deletedAt: null }),
  updateGraphMetadataAdmin: async () => ({ ...GRAPH, title: 'Updated' }),
  repairGraph: async () => ({ repaired: true }),
  listVersions: async () => [],
  restoreVersion: async () => ({ ...GRAPH }),
  pushGraphToUser: async () => ({ pushed: true, share: { id: 'share-1' } }),
  ...overrides,
});

const createFakeUserRepository = (overrides = {}) => ({
  findById: async (id) => [ADMIN_USER, RESEARCH_USER, OTHER_USER].find((u) => u.id === id) ?? null,
  findByEmail: async () => null,
  listAllUsersWithGraphCounts: async () => [{ ...RESEARCH_USER, graphCount: 2 }],
  searchUsers: async () => [{ ...RESEARCH_USER, graphCount: 2 }],
  bumpTokenVersion: async () => {},
  touchLastLogin: async () => {},
  ...overrides,
});

const createFakeMessageRepository = (overrides = {}) => ({
  createMessage: async (input) => ({ id: 'msg-1', ...input }),
  listMessagesForUser: async () => [],
  markMessageRead: async () => ({ id: 'msg-1', readAt: 'now' }),
  ...overrides,
});

const startTestServer = async ({ repository, userRepository, messageRepository } = {}) => {
  const server = http.createServer(createApp(repository ?? createFakeRepository(), {
    userRepository: userRepository ?? createFakeUserRepository(),
    messageRepository: messageRepository ?? createFakeMessageRepository(),
  }));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://localhost:${port}` };
};

const request = async (baseUrl, method, path, { user, body } = {}) => fetch(`${baseUrl}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...authHeader(user) },
  body: body ? JSON.stringify(body) : undefined,
});

// Every admin route this dashboard exposes — used to drive the three
// blanket security checks below (401/403/200) without hand-writing the
// same three tests fourteen times over.
const ADMIN_ROUTES = [
  { method: 'GET', path: '/api/admin/users' },
  { method: 'GET', path: '/api/admin/users/user-1/graphs' },
  { method: 'POST', path: '/api/admin/users/user-1/messages', body: { body: 'hi' } },
  { method: 'GET', path: '/api/admin/graphs' },
  { method: 'GET', path: '/api/admin/graphs/graph-1' },
  { method: 'PATCH', path: '/api/admin/graphs/graph-1', body: { title: 'New' } },
  { method: 'DELETE', path: '/api/admin/graphs/graph-1' },
  { method: 'POST', path: '/api/admin/graphs/graph-1/restore' },
  { method: 'POST', path: '/api/admin/graphs/graph-1/repair' },
  { method: 'GET', path: '/api/admin/graphs/graph-1/versions' },
  { method: 'POST', path: '/api/admin/graphs/graph-1/versions/1/restore' },
  { method: 'POST', path: '/api/admin/graphs/graph-1/push', body: { recipientUserId: 'user-2' } },
  { method: 'GET', path: '/api/admin/diagnostics/failed-jobs' },
  { method: 'GET', path: '/api/admin/diagnostics/corrupted-graphs' },
  { method: 'GET', path: '/api/admin/diagnostics/duplicate-graphs' },
];

for (const route of ADMIN_ROUTES) {
  test(`${route.method} ${route.path} — 401 without any Authorization header`, async () => {
    const { server, baseUrl } = await startTestServer();
    const res = await request(baseUrl, route.method, route.path, { body: route.body });
    assert.equal(res.status, 401);
    server.close();
  });

  test(`${route.method} ${route.path} — 403 for an authenticated research_user (never just hidden in the UI)`, async () => {
    const { server, baseUrl } = await startTestServer();
    const res = await request(baseUrl, route.method, route.path, { user: RESEARCH_USER, body: route.body });
    assert.equal(res.status, 403);
    server.close();
  });

  test(`${route.method} ${route.path} — reachable by an admin`, async () => {
    const { server, baseUrl } = await startTestServer();
    const res = await request(baseUrl, route.method, route.path, { user: ADMIN_USER, body: route.body });
    assert.ok(res.status < 400, `expected a successful status, got ${res.status}: ${await res.text()}`);
    server.close();
  });
}

test('a research_user hitting an admin route never reaches the repository at all (403 short-circuits before any query)', async () => {
  let repositoryCalled = false;
  const repository = createFakeRepository({
    queryGraphsAdmin: async () => { repositoryCalled = true; return []; },
  });
  const { server, baseUrl } = await startTestServer({ repository });
  const res = await request(baseUrl, 'GET', '/api/admin/users/user-2/graphs', { user: RESEARCH_USER });
  assert.equal(res.status, 403);
  assert.equal(repositoryCalled, false, 'a non-admin request must never reach GraphRepository at all');
  server.close();
});

test('GET /api/admin/users/:userId/graphs scopes queryGraphsAdmin to that specific userId', async () => {
  let receivedFilters = null;
  const repository = createFakeRepository({
    queryGraphsAdmin: async (options) => { receivedFilters = options.filters; return []; },
  });
  const { server, baseUrl } = await startTestServer({ repository });
  await request(baseUrl, 'GET', '/api/admin/users/user-2/graphs', { user: ADMIN_USER });
  assert.equal(receivedFilters.ownerUserId, 'user-2');
  server.close();
});

// --- Push Graph to User -----------------------------------------------------

test('POST /api/admin/graphs/:graphId/push grants access and notifies the recipient\'s inbox on a genuine first push', async () => {
  let pushArgs = null;
  let messageArgs = null;
  const repository = createFakeRepository({
    pushGraphToUser: async (args) => { pushArgs = args; return { pushed: true, share: { id: 'share-1' } }; },
  });
  const messageRepository = createFakeMessageRepository({
    createMessage: async (args) => { messageArgs = args; return { id: 'msg-1' }; },
  });
  const { server, baseUrl } = await startTestServer({ repository, messageRepository });

  const res = await request(baseUrl, 'POST', '/api/admin/graphs/graph-1/push', {
    user: ADMIN_USER, body: { recipientUserId: OTHER_USER.id },
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.pushed, true);
  assert.deepEqual(pushArgs, { graphId: 'graph-1', recipientUserId: OTHER_USER.id, pushedByAdminId: ADMIN_USER.id });
  assert.equal(messageArgs.userId, OTHER_USER.id);
  assert.equal(messageArgs.senderAdminId, ADMIN_USER.id);
  assert.equal(messageArgs.messageType, 'push_update');
  assert.equal(messageArgs.body, 'Admin sent you a graph.');
  assert.equal(messageArgs.relatedGraphId, 'graph-1');
  server.close();
});

test('POST /api/admin/graphs/:graphId/push never sends a duplicate notification when the graph was already shared with this user', async () => {
  let messageCreateCalls = 0;
  const repository = createFakeRepository({
    pushGraphToUser: async () => ({ pushed: false }),
  });
  const messageRepository = createFakeMessageRepository({
    createMessage: async (args) => { messageCreateCalls += 1; return { id: 'msg-1', ...args }; },
  });
  const { server, baseUrl } = await startTestServer({ repository, messageRepository });

  const res = await request(baseUrl, 'POST', '/api/admin/graphs/graph-1/push', {
    user: ADMIN_USER, body: { recipientUserId: OTHER_USER.id },
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.pushed, false);
  assert.equal(messageCreateCalls, 0, 'a no-op push (already shared) must never send a second notification');
  server.close();
});

test('POST /api/admin/graphs/:graphId/push returns 400 without a recipientUserId', async () => {
  const { server, baseUrl } = await startTestServer();
  const res = await request(baseUrl, 'POST', '/api/admin/graphs/graph-1/push', { user: ADMIN_USER, body: {} });
  assert.equal(res.status, 400);
  server.close();
});

test('POST /api/admin/graphs/:graphId/push returns 404 for an unknown recipient', async () => {
  const { server, baseUrl } = await startTestServer();
  const res = await request(baseUrl, 'POST', '/api/admin/graphs/graph-1/push', {
    user: ADMIN_USER, body: { recipientUserId: 'nobody' },
  });
  assert.equal(res.status, 404);
  server.close();
});

test('a research_user can never push a graph to another user themselves', async () => {
  let pushCalled = false;
  const repository = createFakeRepository({
    pushGraphToUser: async () => { pushCalled = true; return { pushed: true }; },
  });
  const { server, baseUrl } = await startTestServer({ repository });
  const res = await request(baseUrl, 'POST', '/api/admin/graphs/graph-1/push', {
    user: RESEARCH_USER, body: { recipientUserId: OTHER_USER.id },
  });
  assert.equal(res.status, 403);
  assert.equal(pushCalled, false);
  server.close();
});

// --- /api/messages: a signed-in user's own inbox ---------------------------

test('GET /api/messages returns 401 without auth', async () => {
  const { server, baseUrl } = await startTestServer();
  const res = await fetch(`${baseUrl}/api/messages`);
  assert.equal(res.status, 401);
  server.close();
});

test('GET /api/messages returns the caller\'s own messages, scoped to their own userId', async () => {
  let receivedUserId = null;
  const messageRepository = createFakeMessageRepository({
    listMessagesForUser: async (userId) => { receivedUserId = userId; return [{ id: 'msg-1', body: 'hi' }]; },
  });
  const { server, baseUrl } = await startTestServer({ messageRepository });
  const res = await request(baseUrl, 'GET', '/api/messages', { user: RESEARCH_USER });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(receivedUserId, RESEARCH_USER.id);
  assert.deepEqual(body.messages, [{ id: 'msg-1', body: 'hi' }]);
  server.close();
});

test('PATCH /api/messages/:id/read scopes markMessageRead to the caller\'s own userId', async () => {
  let receivedArgs = null;
  const messageRepository = createFakeMessageRepository({
    markMessageRead: async (id, userId) => { receivedArgs = { id, userId }; return { id, readAt: 'now' }; },
  });
  const { server, baseUrl } = await startTestServer({ messageRepository });
  const res = await request(baseUrl, 'PATCH', '/api/messages/msg-1/read', { user: RESEARCH_USER });
  assert.equal(res.status, 200);
  assert.deepEqual(receivedArgs, { id: 'msg-1', userId: RESEARCH_USER.id });
  server.close();
});

test('a guest (no account at all, so no valid token) cannot reach any admin functionality', async () => {
  const { server, baseUrl } = await startTestServer();
  const res = await request(baseUrl, 'GET', '/api/admin/users');
  assert.equal(res.status, 401);
  server.close();
});
