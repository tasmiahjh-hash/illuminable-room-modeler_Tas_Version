import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCloudAutosave, saveCloudAutosave } from '../src/workspace/workspaceAutosaveClient.js';

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalLocalStorage;
});

const stubSignedIn = (token = 'fake-jwt-token') => {
  globalThis.localStorage = { getItem: (key) => (key === 'illuminable-auth-token' ? token : null) };
};

test('fetchCloudAutosave attaches Authorization and hits GET /api/workspace-autosave', async () => {
  stubSignedIn();
  let capturedUrl, capturedOptions;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url; capturedOptions = options;
    return { ok: true, status: 200, json: async () => ({ autosave: { workspaceData: { sequences: [] }, clientRevision: 2 } }) };
  };
  const result = await fetchCloudAutosave();
  assert.match(capturedUrl, /\/api\/workspace-autosave$/);
  assert.equal(capturedOptions.headers.Authorization, 'Bearer fake-jwt-token');
  assert.equal(result.autosave.clientRevision, 2);
});

test('fetchCloudAutosave surfaces null when the account has never autosaved', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ autosave: null }) });
  const result = await fetchCloudAutosave();
  assert.equal(result.autosave, null);
});

test('saveCloudAutosave PUTs workspaceData + clientRevision as JSON', async () => {
  let capturedOptions;
  globalThis.fetch = async (url, options) => { capturedOptions = options; return { ok: true, status: 200, json: async () => ({ applied: true }) }; };
  await saveCloudAutosave({ sequences: [{ id: 's1' }] }, 7);
  assert.equal(capturedOptions.method, 'PUT');
  assert.deepEqual(JSON.parse(capturedOptions.body), { workspaceData: { sequences: [{ id: 's1' }] }, clientRevision: 7 });
});

test('saveCloudAutosave resolves with applied:false (not a thrown error) when the write is rejected as stale', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ applied: false, autosave: { clientRevision: 9 } }) });
  const result = await saveCloudAutosave({}, 2);
  assert.equal(result.applied, false);
  assert.equal(result.autosave.clientRevision, 9);
});

test('a 401 is reported as an expired session', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'sign in required' }) });
  await assert.rejects(() => fetchCloudAutosave(), /session has expired/);
});

test('a network/timeout failure mentions the cold-start possibility', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  await assert.rejects(() => fetchCloudAutosave(), /waking up|reach the server/);
});
