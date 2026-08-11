import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserRepository } from '../server/repositories/userRepository.js';

// A fake pool: records every query call and lets each test script exactly
// what rows come back, so the repository's own SQL-building/mapping logic
// is fully exercised without a real PostgreSQL connection anywhere —
// mirrors tests/graph-repository.test.mjs's own fake-pool pattern.
const createFakePool = (rows = []) => {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows };
    },
  };
};

const userRow = (overrides = {}) => ({
  id: 'user-1', email: 'researcher@example.com', password_hash: '$2a$12$fakehash',
  display_name: 'Test Researcher', role: 'research_user', token_version: 0,
  created_at: 'created-x', last_login_at: null,
  ...overrides,
});

test('createUser inserts and maps the returned row to the public user model (no passwordHash/tokenVersion)', async () => {
  const row = userRow();
  const pool = createFakePool([row]);
  const repo = createUserRepository(pool);

  const user = await repo.createUser({ email: 'researcher@example.com', passwordHash: '$2a$12$fakehash', displayName: 'Test Researcher' });

  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /INSERT INTO users/);
  assert.deepEqual(pool.calls[0].params, ['researcher@example.com', '$2a$12$fakehash', 'Test Researcher', 'research_user']);
  assert.deepEqual(user, {
    id: 'user-1', email: 'researcher@example.com', displayName: 'Test Researcher',
    role: 'research_user', createdAt: 'created-x', lastLoginAt: null,
  });
  assert.ok(!('passwordHash' in user), 'createUser\'s return value must never include the password hash');
});

test('createUser defaults role to research_user when not specified', async () => {
  const pool = createFakePool([userRow()]);
  const repo = createUserRepository(pool);
  await repo.createUser({ email: 'x@example.com', passwordHash: 'h', displayName: 'X' });
  assert.equal(pool.calls[0].params[3], 'research_user');
});

test('createUser passes an explicit role through (e.g. admin, granted out-of-band)', async () => {
  const pool = createFakePool([userRow({ role: 'admin' })]);
  const repo = createUserRepository(pool);
  await repo.createUser({ email: 'admin@example.com', passwordHash: 'h', displayName: 'Admin', role: 'admin' });
  assert.equal(pool.calls[0].params[3], 'admin');
});

test('findByEmail returns the auth-internal shape, including passwordHash and tokenVersion', async () => {
  const row = userRow();
  const pool = createFakePool([row]);
  const repo = createUserRepository(pool);

  const user = await repo.findByEmail('researcher@example.com');

  assert.match(pool.calls[0].text, /SELECT \* FROM users WHERE email = \$1/);
  assert.deepEqual(pool.calls[0].params, ['researcher@example.com']);
  assert.deepEqual(user, {
    id: 'user-1', email: 'researcher@example.com', displayName: 'Test Researcher',
    role: 'research_user', createdAt: 'created-x', lastLoginAt: null,
    passwordHash: '$2a$12$fakehash', tokenVersion: 0,
  });
});

test('findByEmail returns null when no row matches', async () => {
  const pool = createFakePool([]);
  const repo = createUserRepository(pool);
  assert.equal(await repo.findByEmail('nobody@example.com'), null);
});

test('findById returns the same auth-internal shape as findByEmail', async () => {
  const row = userRow({ id: 'user-2', token_version: 3 });
  const pool = createFakePool([row]);
  const repo = createUserRepository(pool);

  const user = await repo.findById('user-2');

  assert.match(pool.calls[0].text, /SELECT \* FROM users WHERE id = \$1/);
  assert.deepEqual(pool.calls[0].params, ['user-2']);
  assert.equal(user.tokenVersion, 3);
  assert.equal(user.passwordHash, '$2a$12$fakehash');
});

test('findById returns null when no row matches', async () => {
  const pool = createFakePool([]);
  const repo = createUserRepository(pool);
  assert.equal(await repo.findById('missing'), null);
});

test('bumpTokenVersion issues an UPDATE incrementing token_version for the given id', async () => {
  const pool = createFakePool([]);
  const repo = createUserRepository(pool);
  await repo.bumpTokenVersion('user-1');
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /UPDATE users SET token_version = token_version \+ 1 WHERE id = \$1/);
  assert.deepEqual(pool.calls[0].params, ['user-1']);
});

test('touchLastLogin issues an UPDATE setting last_login_at to now for the given id', async () => {
  const pool = createFakePool([]);
  const repo = createUserRepository(pool);
  await repo.touchLastLogin('user-1');
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /UPDATE users SET last_login_at = now\(\) WHERE id = \$1/);
  assert.deepEqual(pool.calls[0].params, ['user-1']);
});
