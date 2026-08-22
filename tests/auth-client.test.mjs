import assert from 'node:assert/strict';
import test from 'node:test';
import { login, signup, fetchMe } from '../src/auth/authClient.js';

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalLocalStorage;
});

test('login surfaces the server\'s own message on a 401 (never rewritten to "session expired" — a wrong password is an expected outcome, not an expired session)', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid email or password' }) });
  await assert.rejects(() => login({ email: 'x@example.com', password: 'wrong' }), /invalid email or password/);
});

test('a 5xx response is reported as a server error, not a raw status code', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => signup({ email: 'x@example.com', password: 'password123', displayName: 'X' }), /server hit an error/);
});

test('a network/timeout failure mentions the cold-start possibility, not just a bare "unreachable"', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  await assert.rejects(() => fetchMe('token'), /waking up|reach the server/);
});
