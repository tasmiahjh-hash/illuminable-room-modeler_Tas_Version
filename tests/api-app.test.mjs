import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../server/api/app.js';
import { signToken } from '../server/auth/tokens.js';

// Every /api/graphs* route now requires auth (see app.js's own comment on
// why: "Research Users can never view/search/edit/delete/load another
// user's graphs" must be a real server-side guarantee, not just a UI
// convention) — signToken needs JWT_SECRET set before it's ever called.
process.env.JWT_SECRET = 'test-secret-never-used-outside-this-suite';

const TEST_USER = { id: 'user-1', email: 'researcher@example.com', displayName: 'Test Researcher', role: 'research_user', tokenVersion: 0 };
const OTHER_USER = { id: 'user-2', email: 'other@example.com', displayName: 'Other Researcher', role: 'research_user', tokenVersion: 0 };
const ADMIN_USER = { id: 'admin-1', email: 'admin@example.com', displayName: 'Test Admin', role: 'admin', tokenVersion: 0 };

/** Authorization header for a test user — mirrors what authClient.js sends in the real app. */
const authHeader = (user = TEST_USER) => ({ Authorization: `Bearer ${signToken(user)}` });

// A fake GraphRepository — real HTTP round trips (via a real ephemeral
// server below), fake data underneath, so this exercises the actual
// request/response cycle (routing, JSON parsing, CORS, error handling)
// without any real PostgreSQL connection.
const createFakeRepository = (overrides = {}) => ({
  getGraphWithGeometry: async () => null,
  uploadExactGraphIfMissing: async () => ({ uploaded: true }),
  recordGraphAccess: async () => {},
  listGraphs: async () => [],
  searchGraphs: async () => [],
  listRecentGraphs: async () => [],
  // Default: no admin-pushed access to anything — the download route's own
  // graph_shares fallback (see app.js's own comment) only matters for the
  // one test that overrides this to simulate a genuinely shared graph.
  userCanAccessGraph: async () => false,
  findById: async () => null,
  ...overrides,
});

// A fake UserRepository — resolves any of the three fixed test users above
// by id, so resolveAuthContext (server/auth/requireAuth.js) never needs a
// real database to validate a test-signed token's tokenVersion.
const createFakeUserRepository = (overrides = {}) => ({
  findById: async (id) => [TEST_USER, OTHER_USER, ADMIN_USER].find((u) => u.id === id) ?? null,
  findByEmail: async () => null,
  createUser: async () => { throw new Error('createFakeUserRepository.createUser not stubbed for this test'); },
  bumpTokenVersion: async () => {},
  touchLastLogin: async () => {},
  ...overrides,
});

// A fake GraphDatabase (the file-based local permanent cache) — same
// reasoning as createFakeRepository: real HTTP round trips, fake data
// underneath, no real filesystem access.
const createFakeGraphDatabase = (overrides = {}) => ({
  loadGraph: async () => null,
  saveGraph: async (input) => ({ id: 'g1', hash: 'h1', metadata: {}, points: input.points, notes: '' }),
  listGraphs: async () => [],
  searchGraphs: async () => [],
  graphExists: async () => true,
  updateGraphMetadata: async (hash, updates) => ({ hash, ...updates }),
  deleteGraph: async () => {},
  ...overrides,
});

const startTestServer = async (repository, options = {}) => {
  const server = http.createServer(createApp(repository, { userRepository: createFakeUserRepository(), ...options }));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://localhost:${port}` };
};

test('GET /api/graphs/:hash returns exists:false when the repository finds nothing', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository());
  const res = await fetch(`${baseUrl}/api/graphs/some-hash`, { headers: authHeader() });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { exists: false });
  server.close();
});

test('GET /api/graphs/:hash returns 401 without a valid Authorization header', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository());
  const res = await fetch(`${baseUrl}/api/graphs/some-hash`);
  assert.equal(res.status, 401);
  server.close();
});

test('GET /api/graphs/:hash returns exists:true with graph+geometry when found and owned by the requester', async () => {
  const graph = { id: 'g1', hash: 'h1', ownerUserId: TEST_USER.id };
  const geometry = { points: [{ a: 1, b: 2 }], pointCount: 1 };
  let receivedHash = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async (hash) => { receivedHash = hash; return { graph, geometry }; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`, { headers: authHeader() });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { exists: true, graph, geometry });
  assert.equal(receivedHash, 'h1');
  server.close();
});

test('GET /api/graphs/:hash returns 403 for a graph owned by a different user', async () => {
  const graph = { id: 'g1', hash: 'h1', ownerUserId: OTHER_USER.id };
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => ({ graph, geometry: { points: [] } }),
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`, { headers: authHeader(TEST_USER) });
  assert.equal(res.status, 403);
  server.close();
});

test('GET /api/graphs/:hash allows a graph owned by someone else through when it was pushed to the requester (graph_shares)', async () => {
  const graph = { id: 'g1', hash: 'h1', ownerUserId: OTHER_USER.id };
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => ({ graph, geometry: { points: [] } }),
    userCanAccessGraph: async () => true,
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`, { headers: authHeader(TEST_USER) });
  assert.equal(res.status, 200);
  server.close();
});

test('GET /api/graphs/:hash allows an unowned (legacy) graph through — it is nobody else\'s', async () => {
  const graph = { id: 'g1', hash: 'h1', ownerUserId: null };
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => ({ graph, geometry: { points: [] } }),
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`, { headers: authHeader(TEST_USER) });
  assert.equal(res.status, 200);
  server.close();
});

test('GET /api/graphs/:hash lets an admin access a graph owned by someone else', async () => {
  const graph = { id: 'g1', hash: 'h1', ownerUserId: OTHER_USER.id };
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => ({ graph, geometry: { points: [] } }),
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`, { headers: authHeader(ADMIN_USER) });
  assert.equal(res.status, 200);
  server.close();
});

test('GET /api/graphs/:hash URL-decodes the hash before passing it to the repository', async () => {
  let receivedHash = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async (hash) => { receivedHash = hash; return null; },
  }));
  await fetch(`${baseUrl}/api/graphs/${encodeURIComponent('alg1|code(a b)|a(1)')}`, { headers: authHeader() });
  assert.equal(receivedHash, 'alg1|code(a b)|a(1)');
  server.close();
});

// --- GET /api/graphs/by-id/:id — backs the inbox's "Load Graph" ------------

test('GET /api/graphs/by-id/:id returns exists:false when no graph has this id', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository({ findById: async () => null }));
  const res = await fetch(`${baseUrl}/api/graphs/by-id/missing`, { headers: authHeader() });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { exists: false });
  server.close();
});

test('GET /api/graphs/by-id/:id returns the graph+geometry when owned by the requester', async () => {
  const graph = { id: 'graph-1', hash: 'hash-abc', ownerUserId: TEST_USER.id };
  const geometry = { points: [{ a: 1, b: 2 }], pointCount: 1 };
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    findById: async () => graph,
    getGraphWithGeometry: async () => ({ graph, geometry }),
  }));
  const res = await fetch(`${baseUrl}/api/graphs/by-id/graph-1`, { headers: authHeader() });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { exists: true, graph, geometry });
  server.close();
});

test('GET /api/graphs/by-id/:id returns 403 for a graph owned by someone else and never shared', async () => {
  const graph = { id: 'graph-1', hash: 'hash-abc', ownerUserId: OTHER_USER.id };
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    findById: async () => graph,
    userCanAccessGraph: async () => false,
  }));
  const res = await fetch(`${baseUrl}/api/graphs/by-id/graph-1`, { headers: authHeader(TEST_USER) });
  assert.equal(res.status, 403);
  server.close();
});

test('GET /api/graphs/by-id/:id allows a graph pushed to the requester via graph_shares', async () => {
  const graph = { id: 'graph-1', hash: 'hash-abc', ownerUserId: OTHER_USER.id };
  const geometry = { points: [], pointCount: 0 };
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    findById: async () => graph,
    userCanAccessGraph: async () => true,
    getGraphWithGeometry: async () => ({ graph, geometry }),
  }));
  const res = await fetch(`${baseUrl}/api/graphs/by-id/graph-1`, { headers: authHeader(TEST_USER) });
  assert.equal(res.status, 200);
  server.close();
});

test('POST /api/graphs uploads via the repository, stamping ownerUserId from the authenticated session', async () => {
  let receivedBody = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    uploadExactGraphIfMissing: async (body) => { receivedBody = body; return { uploaded: true, graph: { id: 'g1' } }; },
  }));
  const payload = {
    params: { sequenceText: 'X', angleA: 1, angleB: 2, angleStepInput: '0.1', baseLength: 90 },
    points: [{ a: 1, b: 2 }], durationMs: 100,
  };
  const res = await fetch(`${baseUrl}/api/graphs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify(payload),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { uploaded: true, graph: { id: 'g1' } });
  assert.deepEqual(receivedBody, { ...payload, ownerUserId: TEST_USER.id });
  server.close();
});

test('POST /api/graphs ignores a client-supplied ownerUserId and always uses the authenticated session\'s own id', async () => {
  let receivedBody = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    uploadExactGraphIfMissing: async (body) => { receivedBody = body; return { uploaded: true }; },
  }));
  const payload = {
    params: { sequenceText: 'X', angleA: 1, angleB: 2, angleStepInput: '0.1', baseLength: 90 },
    points: [{ a: 1, b: 2 }], ownerUserId: OTHER_USER.id,
  };
  await fetch(`${baseUrl}/api/graphs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader(TEST_USER) }, body: JSON.stringify(payload),
  });
  assert.equal(receivedBody.ownerUserId, TEST_USER.id);
  server.close();
});

test('POST /api/graphs rejects a request missing params or points with 400, never touching the repository', async () => {
  let called = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    uploadExactGraphIfMissing: async () => { called = true; return { uploaded: true }; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.equal(called, false);
  server.close();
});

test('a repository failure (e.g. Postgres unavailable) returns 503, not a crash', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => { throw new Error('connection refused'); },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`, { headers: authHeader() });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.ok(body.error);
  server.close();
});

test('unknown routes return 404', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository());
  const res = await fetch(`${baseUrl}/api/unknown`);
  assert.equal(res.status, 404);
  server.close();
});

test('OPTIONS preflight requests get CORS headers and a 204, without touching the repository', async () => {
  let called = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => { called = true; return null; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(called, false);
  server.close();
});

// --- Shared graph library routes (Phase 6) --------------------------------

test('GET /api/graphs calls listGraphs with parsed query options, scoped to the requester\'s own graphs', async () => {
  let receivedOptions = null;
  const graphs = [{ hash: 'h1', pointCount: 10 }];
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    listGraphs: async (options) => { receivedOptions = options; return graphs; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs?sort=oldest&limit=5`, { headers: authHeader() });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { graphs });
  assert.deepEqual(receivedOptions, { sort: 'oldest', limit: 5, filters: { visibleToUserId: TEST_USER.id } });
  server.close();
});

test('GET /api/graphs always ANDs a client-supplied ownerUserId filter with the requester\'s own forced visibleToUserId, never replacing it', async () => {
  let receivedOptions = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    listGraphs: async (options) => { receivedOptions = options; return []; },
  }));
  await fetch(`${baseUrl}/api/graphs?ownerUserId=${OTHER_USER.id}`, { headers: authHeader(TEST_USER) });
  // buildGraphFilterClause ANDs both — the requester can never see anything
  // outside their own visibleToUserId scope (owned or shared-with-them) no
  // matter what ownerUserId they pass; see graphRepository.js's own
  // visibleToUserId comment.
  assert.deepEqual(receivedOptions.filters, { ownerUserId: OTHER_USER.id, visibleToUserId: TEST_USER.id });
  server.close();
});

test('GET /api/graphs for an admin is not scoped to any single owner', async () => {
  let receivedOptions = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    listGraphs: async (options) => { receivedOptions = options; return []; },
  }));
  await fetch(`${baseUrl}/api/graphs`, { headers: authHeader(ADMIN_USER) });
  assert.deepEqual(receivedOptions.filters, {});
  server.close();
});

test('GET /api/graphs/search calls searchGraphs with the parsed search query and list options, scoped to the requester', async () => {
  let receivedQuery = null;
  let receivedOptions = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    searchGraphs: async (query, options) => { receivedQuery = query; receivedOptions = options; return []; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/search?code=RRL&angleA=15&sort=most_downloaded`, { headers: authHeader() });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { graphs: [] });
  assert.deepEqual(receivedQuery, { sequenceText: 'RRL', angleA: 15 });
  assert.deepEqual(receivedOptions, { sort: 'most_downloaded', filters: { visibleToUserId: TEST_USER.id } });
  server.close();
});

test('GET /api/graphs/recent calls listRecentGraphs and is matched before the generic :hash route', async () => {
  let recentCalled = false;
  let hashRouteCalled = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    listRecentGraphs: async () => { recentCalled = true; return []; },
    getGraphWithGeometry: async () => { hashRouteCalled = true; return null; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/recent`, { headers: authHeader() });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { graphs: [] });
  assert.equal(recentCalled, true);
  assert.equal(hashRouteCalled, false, '"recent" must never be treated as a hash by the download route');
  server.close();
});

test('GET /api/graphs/search is matched before the generic :hash route (never treated as a hash)', async () => {
  let hashRouteCalled = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    searchGraphs: async () => [],
    getGraphWithGeometry: async () => { hashRouteCalled = true; return null; },
  }));
  await fetch(`${baseUrl}/api/graphs/search?hash=abc`, { headers: authHeader() });
  assert.equal(hashRouteCalled, false);
  server.close();
});

test('a successful GET /api/graphs/:hash records access via recordGraphAccess', async () => {
  let recordedHash = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => ({ graph: { hash: 'h1' }, geometry: { points: [] } }),
    recordGraphAccess: async (hash) => { recordedHash = hash; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`, { headers: authHeader() });
  assert.equal(res.status, 200);
  // recordGraphAccess is fire-and-forget (not awaited by the route), so
  // give its microtask a turn to run before asserting.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recordedHash, 'h1');
  server.close();
});

test('a miss on GET /api/graphs/:hash never calls recordGraphAccess', async () => {
  let called = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => null,
    recordGraphAccess: async () => { called = true; },
  }));
  await fetch(`${baseUrl}/api/graphs/missing-hash`, { headers: authHeader() });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(called, false);
  server.close();
});

test('a recordGraphAccess failure never affects the download response itself', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => ({ graph: { hash: 'h1' }, geometry: { points: [] } }),
    recordGraphAccess: async () => { throw new Error('tracking db down'); },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`, { headers: authHeader() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.exists, true);
  server.close();
});

test('browse/search/recent routes never return a `points` field, even if the repository fake includes one', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    listGraphs: async () => [{ hash: 'h1', pointCount: 5, hasExactGeometry: true }],
  }));
  const res = await fetch(`${baseUrl}/api/graphs`, { headers: authHeader() });
  const body = await res.json();
  assert.ok(!('points' in body.graphs[0]));
  server.close();
});

// --- Local file-based GraphDatabase routes (permanent render cache) -------

test('GET /api/local-graphs/:hash returns exists:false when the local GraphDatabase finds nothing', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository(), { graphDatabase: createFakeGraphDatabase() });
  const res = await fetch(`${baseUrl}/api/local-graphs/some-hash`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { exists: false });
  server.close();
});

test('GET /api/local-graphs/:hash returns exists:true with the graph when found', async () => {
  const graph = { id: 'g1', hash: 'h1', metadata: { computeTimeMs: 10 }, points: [{ a: 1, b: 2 }], notes: '' };
  let receivedHash = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({ loadGraph: async (hash) => { receivedHash = hash; return graph; } }),
  });
  const res = await fetch(`${baseUrl}/api/local-graphs/h1`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { exists: true, graph });
  assert.equal(receivedHash, 'h1');
  server.close();
});

test('GET /api/local-graphs/:hash URL-decodes the hash before passing it to the GraphDatabase', async () => {
  let receivedHash = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({ loadGraph: async (hash) => { receivedHash = hash; return null; } }),
  });
  await fetch(`${baseUrl}/api/local-graphs/${encodeURIComponent('alg1|code(a b)|a(1)')}`);
  assert.equal(receivedHash, 'alg1|code(a b)|a(1)');
  server.close();
});

test('POST /api/local-graphs saves via the GraphDatabase and returns { saved: true, graph }', async () => {
  let receivedInput = null;
  const savedGraph = { id: 'g1', hash: 'h1', metadata: {}, points: [{ a: 1, b: 2 }], notes: '' };
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({ saveGraph: async (input) => { receivedInput = input; return savedGraph; } }),
  });
  const payload = {
    params: { sequenceText: 'X', angleA: 1, angleB: 2, angleStepInput: '0.1', baseLength: 90 },
    points: [{ a: 1, b: 2 }], computeTimeMs: 100,
  };
  const res = await fetch(`${baseUrl}/api/local-graphs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { saved: true, graph: savedGraph });
  assert.deepEqual(receivedInput, payload);
  server.close();
});

test('POST /api/local-graphs rejects a request missing params or points with 400, never touching the GraphDatabase', async () => {
  let called = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({ saveGraph: async () => { called = true; } }),
  });
  const res = await fetch(`${baseUrl}/api/local-graphs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.equal(called, false);
  server.close();
});

test('a GraphDatabase failure (e.g. disk error) on /api/local-graphs returns 503, not a crash', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({ loadGraph: async () => { throw new Error('EACCES'); } }),
  });
  const res = await fetch(`${baseUrl}/api/local-graphs/h1`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.ok(body.error);
  server.close();
});

test('/api/local-graphs never collides with /api/graphs (the PostgreSQL-backed routes)', async () => {
  let repoCalled = false;
  let dbCalled = false;
  const { server, baseUrl } = await startTestServer(
    createFakeRepository({ getGraphWithGeometry: async () => { repoCalled = true; return null; } }),
    { graphDatabase: createFakeGraphDatabase({ loadGraph: async () => { dbCalled = true; return null; } }) },
  );
  await fetch(`${baseUrl}/api/local-graphs/h1`);
  assert.equal(dbCalled, true);
  assert.equal(repoCalled, false);
  server.close();
});

// --- Graph Database browser: browse/search/rename/favorite/delete --------

test('GET /api/local-graphs calls listGraphs with parsed sort/limit/offset and returns { graphs } (metadata only)', async () => {
  let receivedOptions = null;
  const graphs = [{ hash: 'h1', pointCount: 10 }];
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({ listGraphs: async (options) => { receivedOptions = options; return graphs; } }),
  });
  const res = await fetch(`${baseUrl}/api/local-graphs?sort=oldest&limit=5`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { graphs });
  assert.deepEqual(receivedOptions, { sortBy: 'createdAt', order: 'asc', limit: 5 });
  server.close();
});

test('GET /api/local-graphs/search calls searchGraphs with the parsed query and list options, and is matched before the generic :hash route', async () => {
  let receivedQuery = null;
  let receivedOptions = null;
  let hashRouteCalled = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({
      searchGraphs: async (query, options) => { receivedQuery = query; receivedOptions = options; return []; },
      loadGraph: async () => { hashRouteCalled = true; return null; },
    }),
  });
  const res = await fetch(`${baseUrl}/api/local-graphs/search?code=RRL&angleA=15&sort=title_asc&favorite=true`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { graphs: [] });
  assert.deepEqual(receivedQuery, { codeSequence: 'RRL', angleA: 15, favorite: true });
  assert.deepEqual(receivedOptions, { sortBy: 'title', order: 'asc' });
  assert.equal(hashRouteCalled, false, '"search" must never be treated as a hash by the download route');
  server.close();
});

test('GET /api/local-graphs/search?q=... calls searchGraphs with { text }', async () => {
  let receivedQuery = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({
      searchGraphs: async (query) => { receivedQuery = query; return []; },
    }),
  });
  const res = await fetch(`${baseUrl}/api/local-graphs/search?${new URLSearchParams({ q: 'boundary case' })}`);
  assert.equal(res.status, 200);
  assert.deepEqual(receivedQuery, { text: 'boundary case' });
  server.close();
});

test('PATCH /api/local-graphs/:hash updates metadata via updateGraphMetadata and returns { updated: true, metadata }', async () => {
  let receivedHash = null;
  let receivedUpdates = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({
      updateGraphMetadata: async (hash, updates) => { receivedHash = hash; receivedUpdates = updates; return { hash, ...updates }; },
    }),
  });
  const res = await fetch(`${baseUrl}/api/local-graphs/h1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: true, title: 'Renamed' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { updated: true, metadata: { hash: 'h1', favorite: true, title: 'Renamed' } });
  assert.equal(receivedHash, 'h1');
  assert.deepEqual(receivedUpdates, { favorite: true, title: 'Renamed' });
  server.close();
});

test('PATCH /api/local-graphs/:hash returns 404 (not 503) for a hash that was never saved', async () => {
  let updateCalled = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({
      graphExists: async () => false,
      updateGraphMetadata: async () => { updateCalled = true; },
    }),
  });
  const res = await fetch(`${baseUrl}/api/local-graphs/missing-hash`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: true }),
  });
  assert.equal(res.status, 404);
  assert.equal(updateCalled, false);
  server.close();
});

test('DELETE /api/local-graphs/:hash deletes via the GraphDatabase and returns { deleted: true }', async () => {
  let receivedHash = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({ deleteGraph: async (hash) => { receivedHash = hash; } }),
  });
  const res = await fetch(`${baseUrl}/api/local-graphs/h1`, { method: 'DELETE' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { deleted: true });
  assert.equal(receivedHash, 'h1');
  server.close();
});

test('DELETE /api/local-graphs/:hash returns 200 { deleted: true } even for a hash that was never saved (idempotent)', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository(), { graphDatabase: createFakeGraphDatabase() });
  const res = await fetch(`${baseUrl}/api/local-graphs/never-saved`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: true });
  server.close();
});

// --- /health and CORS_ORIGIN (deployment) ---------------------------------

test('GET /health returns 200 { status: "ok" } without touching the repository', async () => {
  let repositoryTouched = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    listGraphs: async () => { repositoryTouched = true; return []; },
  }));
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
  assert.equal(repositoryTouched, false);
  server.close();
});

test('with CORS_ORIGIN unset, Access-Control-Allow-Origin is a wildcard (local-dev default)', async () => {
  const original = process.env.CORS_ORIGIN;
  delete process.env.CORS_ORIGIN;
  try {
    const { server, baseUrl } = await startTestServer(createFakeRepository());
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    server.close();
  } finally {
    if (original !== undefined) process.env.CORS_ORIGIN = original;
  }
});

test('with CORS_ORIGIN set, a matching request Origin is echoed back with Vary: Origin', async () => {
  const original = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = 'https://example.github.io,https://other.example';
  try {
    const { server, baseUrl } = await startTestServer(createFakeRepository());
    const res = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://example.github.io' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.github.io');
    assert.equal(res.headers.get('vary'), 'Origin');
    server.close();
  } finally {
    if (original === undefined) delete process.env.CORS_ORIGIN; else process.env.CORS_ORIGIN = original;
  }
});

test('with CORS_ORIGIN set, a non-matching request Origin gets no Access-Control-Allow-Origin header', async () => {
  const original = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = 'https://example.github.io';
  try {
    const { server, baseUrl } = await startTestServer(createFakeRepository());
    const res = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://not-allowed.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    server.close();
  } finally {
    if (original === undefined) delete process.env.CORS_ORIGIN; else process.env.CORS_ORIGIN = original;
  }
});
