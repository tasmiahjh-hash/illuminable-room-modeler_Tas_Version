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
    role: 'research_user', createdAt: 'created-x', lastLoginAt: null, lastSeenAt: null,
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
    role: 'research_user', createdAt: 'created-x', lastLoginAt: null, lastSeenAt: null,
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

test('touchLastSeen issues an UPDATE setting last_seen_at to now for the given id', async () => {
  const pool = createFakePool([]);
  const repo = createUserRepository(pool);
  await repo.touchLastSeen('user-1');
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /UPDATE users SET last_seen_at = now\(\) WHERE id = \$1/);
  assert.deepEqual(pool.calls[0].params, ['user-1']);
});

test('listAllUsers selects every user, newest first, mapped to the public model', async () => {
  const pool = createFakePool([userRow(), userRow({ id: 'user-2', role: 'admin' })]);
  const repo = createUserRepository(pool);
  const users = await repo.listAllUsers();
  assert.match(pool.calls[0].text, /SELECT \* FROM users ORDER BY created_at DESC/);
  assert.equal(users.length, 2);
  assert.ok(!('passwordHash' in users[0]), 'listAllUsers must never leak passwordHash');
});

test('listAllUsersWithGraphCounts joins graphs and maps graphCount as a number', async () => {
  const pool = createFakePool([{ ...userRow(), graph_count: '3' }]);
  const repo = createUserRepository(pool);
  const users = await repo.listAllUsersWithGraphCounts();
  assert.match(pool.calls[0].text, /LEFT JOIN graphs g ON g\.owner_user_id = u\.id/);
  assert.match(pool.calls[0].text, /deleted_at IS NULL/);
  assert.equal(users[0].graphCount, 3);
  assert.equal(typeof users[0].graphCount, 'number');
});

test('searchUsers ILIKE-matches email or displayName and includes graphCount', async () => {
  const pool = createFakePool([{ ...userRow(), graph_count: '0' }]);
  const repo = createUserRepository(pool);
  const users = await repo.searchUsers('resear');
  assert.match(pool.calls[0].text, /u\.email ILIKE \$1 OR u\.display_name ILIKE \$1/);
  assert.deepEqual(pool.calls[0].params, ['%resear%']);
  assert.equal(users[0].graphCount, 0);
});

test('updateRole issues an UPDATE for role and returns the updated public model', async () => {
  const pool = createFakePool([userRow({ role: 'admin' })]);
  const repo = createUserRepository(pool);
  const user = await repo.updateRole('user-1', 'admin');
  assert.match(pool.calls[0].text, /UPDATE users SET role = \$2 WHERE id = \$1/);
  assert.deepEqual(pool.calls[0].params, ['user-1', 'admin']);
  assert.equal(user.role, 'admin');
});

test('updateRole returns null when no account has this id', async () => {
  const pool = createFakePool([]);
  const repo = createUserRepository(pool);
  assert.equal(await repo.updateRole('missing', 'admin'), null);
});
