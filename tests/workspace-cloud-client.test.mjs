import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkspaceSnapshot, listWorkspaceSnapshots, getWorkspaceSnapshot, deleteWorkspaceSnapshot,
} from '../src/workspace/workspaceCloudClient.js';

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalLocalStorage;
});

const stubSignedIn = (token = 'fake-jwt-token') => {
  globalThis.localStorage = { getItem: (key) => (key === 'illuminable-auth-token' ? token : null) };
};

test('createWorkspaceSnapshot posts title/workspaceData with Authorization attached', async () => {
  stubSignedIn();
  let capturedUrl, capturedOptions;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url; capturedOptions = options;
    return { ok: true, json: async () => ({ snapshot: { id: 'snap-1' } }) };
  };
  const result = await createWorkspaceSnapshot({ title: 'My Save', workspaceData: { sequences: [] } });
  assert.match(capturedUrl, /\/api\/workspaces$/);
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers.Authorization, 'Bearer fake-jwt-token');
  assert.deepEqual(JSON.parse(capturedOptions.body), { title: 'My Save', workspaceData: { sequences: [] } });
  assert.deepEqual(result, { snapshot: { id: 'snap-1' } });
});

test('createWorkspaceSnapshot throws a readable error on failure (never fails silently, unlike the background auto-save)', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
  await assert.rejects(() => createWorkspaceSnapshot({ title: '', workspaceData: {} }), /boom/);
});

test('createWorkspaceSnapshot throws a readable error when fetch itself rejects', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  await assert.rejects(() => createWorkspaceSnapshot({ title: '', workspaceData: {} }), /reach the server/);
});

test('listWorkspaceSnapshots with no options hits GET /api/workspaces with no query string', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ snapshots: [] }) }; };
  await listWorkspaceSnapshots();
  assert.match(capturedUrl, /\/api\/workspaces$/);
});

test('listWorkspaceSnapshots passes q/limit/offset as query params', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ snapshots: [] }) }; };
  await listWorkspaceSnapshots({ q: 'Tasmiya', limit: 10, offset: 5 });
  assert.match(capturedUrl, /q=Tasmiya/);
  assert.match(capturedUrl, /limit=10/);
  assert.match(capturedUrl, /offset=5/);
});

test('getWorkspaceSnapshot URL-encodes the id and returns the full snapshot', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ snapshot: { id: 'snap 1', workspaceData: { sequences: [] } } }) }; };
  const result = await getWorkspaceSnapshot('snap 1');
  assert.ok(capturedUrl.endsWith(encodeURIComponent('snap 1')));
  assert.deepEqual(result.snapshot.workspaceData, { sequences: [] });
});

test('deleteWorkspaceSnapshot issues a DELETE to the snapshot\'s own URL', async () => {
  let capturedUrl, capturedOptions;
  globalThis.fetch = async (url, options) => { capturedUrl = url; capturedOptions = options; return { ok: true, json: async () => ({ deleted: true }) }; };
  await deleteWorkspaceSnapshot('snap-1');
  assert.match(capturedUrl, /\/api\/workspaces\/snap-1$/);
  assert.equal(capturedOptions.method, 'DELETE');
});
