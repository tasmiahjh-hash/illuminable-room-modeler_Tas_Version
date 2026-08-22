import assert from 'node:assert/strict';
import test from 'node:test';
import { listUsers } from '../src/admin/adminClient.js';

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('a 401 response is reported as an expired session, not a generic failure', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'sign in required' }) });
  await assert.rejects(() => listUsers(), /session has expired/);
});

test('a 403 response is reported as a permission error, not a generic failure', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'admin access required' }) });
  await assert.rejects(() => listUsers(), /admin access required/);
});

test('a 5xx response is reported as a server error, not a raw status code', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => listUsers(), /server hit an error/);
});

test('a network/timeout failure mentions the cold-start possibility, not just a bare "unreachable"', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  await assert.rejects(() => listUsers(), /waking up|reach the server/);
});
