import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRemoteExactGraph, uploadRemoteExactGraph, fetchGraphLibraryPage } from '../src/anglePlot/remoteGraphRepository.js';

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalLocalStorage;
});

// Every /api/graphs* route requires auth (see server/api/app.js) — this
// simulates a signed-in browser tab's own localStorage (authClient.js's
// own getStoredToken reads this same key) so these tests can confirm the
// Authorization header actually gets attached, the exact regression that
// went unnoticed after the RDS auth phase added the requirement without
// updating this file (see remoteGraphRepository.js's own authHeaders comment).
const stubSignedIn = (token = 'fake-jwt-token') => {
  globalThis.localStorage = { getItem: (key) => (key === 'illuminable-auth-token' ? token : null) };
};

test('fetchRemoteExactGraph returns points+durationMs when the server has the graph', async () => {
  globalThis.fetch = async (url) => {
    assert.match(url, /\/api\/graphs\/hash-abc$/);
    return { ok: true, json: async () => ({ exists: true, geometry: { points: [{ a: 1, b: 2 }], durationMs: 42 } }) };
  };
  const result = await fetchRemoteExactGraph('hash-abc');
  assert.deepEqual(result, { points: [{ a: 1, b: 2 }], durationMs: 42 });
});

test('fetchRemoteExactGraph returns null when the server says exists:false', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ exists: false }) });
  assert.equal(await fetchRemoteExactGraph('hash-abc'), null);
});

test('fetchRemoteExactGraph returns null (not throws) on a non-ok response', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  assert.equal(await fetchRemoteExactGraph('hash-abc'), null);
});

test('fetchRemoteExactGraph returns null (not throws) when fetch itself rejects (e.g. connection refused)', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await fetchRemoteExactGraph('hash-abc'), null);
});

test('fetchRemoteExactGraph returns null if the server never responds within the timeout', async () => {
  globalThis.fetch = (url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const result = await fetchRemoteExactGraph('hash-abc', { timeoutMs: 30 });
  assert.equal(result, null);
});

test('fetchRemoteExactGraph URL-encodes the hash', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ exists: false }) }; };
  await fetchRemoteExactGraph('alg1|code(a b)');
  assert.ok(capturedUrl.endsWith(encodeURIComponent('alg1|code(a b)')));
});

test('fetchRemoteExactGraph attaches Authorization when a token is stored (signed-in browser tab)', async () => {
  stubSignedIn('fake-jwt-token');
  let capturedOptions;
  globalThis.fetch = async (url, options) => { capturedOptions = options; return { ok: true, json: async () => ({ exists: false }) }; };
  await fetchRemoteExactGraph('hash-abc');
  assert.equal(capturedOptions.headers.Authorization, 'Bearer fake-jwt-token');
});

test('fetchRemoteExactGraph sends no Authorization header when no token is stored', async () => {
  let capturedOptions;
  globalThis.fetch = async (url, options) => { capturedOptions = options; return { ok: true, json: async () => ({ exists: false }) }; };
  await fetchRemoteExactGraph('hash-abc');
  assert.ok(!('Authorization' in capturedOptions.headers));
});

test('uploadRemoteExactGraph posts params/algorithmVersion/points/durationMs as JSON', async () => {
  let capturedUrl;
  let capturedOptions;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, json: async () => ({ uploaded: true }) };
  };
  const params = { sequenceText: 'X', angleA: 1, angleB: 2, angleStepInput: '0.1', baseLength: 90 };
  const result = await uploadRemoteExactGraph(params, 1, [{ a: 1, b: 2 }], 500);
  assert.match(capturedUrl, /\/api\/graphs$/);
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(capturedOptions.body), { params, algorithmVersion: 1, points: [{ a: 1, b: 2 }], durationMs: 500 });
  assert.deepEqual(result, { ok: true, uploaded: true });
});

test('uploadRemoteExactGraph attaches Authorization when a token is stored — the exact bug that silently broke every automatic background save since the RDS auth phase', async () => {
  stubSignedIn('fake-jwt-token');
  let capturedOptions;
  globalThis.fetch = async (url, options) => { capturedOptions = options; return { ok: true, json: async () => ({ uploaded: true }) }; };
  await uploadRemoteExactGraph({}, 1, [], null);
  assert.equal(capturedOptions.headers.Authorization, 'Bearer fake-jwt-token');
});

test('uploadRemoteExactGraph never throws when fetch itself rejects, and reports ok:false', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  let result;
  await assert.doesNotReject(async () => { result = await uploadRemoteExactGraph({}, 1, [], null); });
  assert.deepEqual(result, { ok: false });
});

test('uploadRemoteExactGraph never throws on a non-ok response, and reports ok:false', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  let result;
  await assert.doesNotReject(async () => { result = await uploadRemoteExactGraph({}, 1, [], null); });
  assert.deepEqual(result, { ok: false });
});

test('uploadRemoteExactGraph never throws when the server times out, and reports ok:false', async () => {
  globalThis.fetch = (url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  let result;
  await assert.doesNotReject(async () => { result = await uploadRemoteExactGraph({}, 1, [], null, { timeoutMs: 30 }); });
  assert.deepEqual(result, { ok: false });
});

// --- fetchGraphLibraryPage (Graph Library browse/search client) ----------

test('fetchGraphLibraryPage with no search fields hits GET /api/graphs (browse, not search)', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ graphs: [] }) }; };
  await fetchGraphLibraryPage();
  assert.match(capturedUrl, /\/api\/graphs\?/);
  assert.ok(!capturedUrl.includes('/api/graphs/search'));
});

test('fetchGraphLibraryPage routes to GET /api/graphs/search the moment any search field is present', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ graphs: [] }) }; };
  await fetchGraphLibraryPage({ search: { code: 'RRL' } });
  assert.match(capturedUrl, /\/api\/graphs\/search\?/);
  assert.match(capturedUrl, /code=RRL/);
});

test('fetchGraphLibraryPage attaches Authorization when a token is stored', async () => {
  stubSignedIn('fake-jwt-token');
  let capturedOptions;
  globalThis.fetch = async (url, options) => { capturedOptions = options; return { ok: true, json: async () => ({ graphs: [] }) }; };
  await fetchGraphLibraryPage();
  assert.equal(capturedOptions.headers.Authorization, 'Bearer fake-jwt-token');
});

test('fetchGraphLibraryPage passes sort/limit/offset as query params', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ graphs: [] }) }; };
  await fetchGraphLibraryPage({ sort: 'oldest', limit: 20, offset: 40 });
  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.get('sort'), 'oldest');
  assert.equal(url.searchParams.get('limit'), '20');
  assert.equal(url.searchParams.get('offset'), '40');
});

test('fetchGraphLibraryPage passes filters (onlyExactGraphs, ownerUserId, algorithmVersion, date range) as query params', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ graphs: [] }) }; };
  await fetchGraphLibraryPage({
    filters: { onlyExactGraphs: true, ownerUserId: 'user-1', algorithmVersion: 1, createdAfter: '2026-01-01', createdBefore: '2026-02-01' },
  });
  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.get('onlyExactGraphs'), 'true');
  assert.equal(url.searchParams.get('ownerUserId'), 'user-1');
  assert.equal(url.searchParams.get('algorithmVersion'), '1');
  assert.equal(url.searchParams.get('createdAfter'), '2026-01-01');
  assert.equal(url.searchParams.get('createdBefore'), '2026-02-01');
});

test('fetchGraphLibraryPage passes hash/code/angleA/angleB/baseLength search fields as query params', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ graphs: [] }) }; };
  await fetchGraphLibraryPage({ search: { hash: 'alg1|code(x)', angleA: 15, angleB: 50, baseLength: 90 } });
  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.get('hash'), 'alg1|code(x)');
  assert.equal(url.searchParams.get('angleA'), '15');
  assert.equal(url.searchParams.get('angleB'), '50');
  assert.equal(url.searchParams.get('baseLength'), '90');
});

test('fetchGraphLibraryPage returns { graphs, error: false } on success', async () => {
  const graphs = [{ hash: 'h1' }, { hash: 'h2' }];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ graphs }) });
  const result = await fetchGraphLibraryPage();
  assert.deepEqual(result, { graphs, error: false });
});

test('fetchGraphLibraryPage returns { graphs: [], error: true } on a non-ok response, never throws', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  const result = await fetchGraphLibraryPage();
  assert.deepEqual(result, { graphs: [], error: true });
});

test('fetchGraphLibraryPage returns { graphs: [], error: true } when fetch itself rejects, never throws', async () => {
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  const result = await fetchGraphLibraryPage();
  assert.deepEqual(result, { graphs: [], error: true });
});

test('fetchGraphLibraryPage returns { graphs: [], error: true } on timeout', async () => {
  globalThis.fetch = (url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const result = await fetchGraphLibraryPage({}, { timeoutMs: 30 });
  assert.deepEqual(result, { graphs: [], error: true });
});

test('fetchGraphLibraryPage defaults a missing graphs field in the response to an empty array', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  const result = await fetchGraphLibraryPage();
  assert.deepEqual(result, { graphs: [], error: false });
});
