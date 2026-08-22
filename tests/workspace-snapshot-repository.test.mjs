import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceSnapshotRepository } from '../server/repositories/workspaceSnapshotRepository.js';

// Fake pool mirrors tests/graph-repository.test.mjs / tests/user-repository.test.mjs's own pattern.
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

const snapshotRow = (overrides = {}) => ({
  id: 'snap-1', owner_user_id: 'user-1', owner_display_name: 'Tasmiya Hasan',
  title: 'Testing long ABC sequences', workspace_data: { sequences: [{ id: 'seq-1' }] },
  graph_count: 1, created_at: '2026-08-22T15:42:00.000Z',
  ...overrides,
});

test('createSnapshot inserts and returns the metadata-only model (no workspace_data in the response)', async () => {
  const pool = createFakePool([snapshotRow()]);
  const repo = createWorkspaceSnapshotRepository(pool);

  const result = await repo.createSnapshot({
    ownerUserId: 'user-1', ownerDisplayName: 'Tasmiya Hasan', title: 'Testing long ABC sequences',
    workspaceData: { sequences: [{ id: 'seq-1' }] }, graphCount: 1,
  });

  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /INSERT INTO workspace_snapshots/);
  assert.deepEqual(pool.calls[0].params, [
    'user-1', 'Tasmiya Hasan', 'Testing long ABC sequences', JSON.stringify({ sequences: [{ id: 'seq-1' }] }), 1,
  ]);
  assert.deepEqual(result, {
    id: 'snap-1', ownerUserId: 'user-1', ownerDisplayName: 'Tasmiya Hasan',
    title: 'Testing long ABC sequences', graphCount: 1, createdAt: '2026-08-22T15:42:00.000Z',
  });
  assert.ok(!('workspaceData' in result), 'createSnapshot\'s own return value must never include the full payload');
});

test('createSnapshot stores a null title when none is given (optional, per the spec\'s own "not forced")', async () => {
  const pool = createFakePool([snapshotRow({ title: null })]);
  const repo = createWorkspaceSnapshotRepository(pool);
  await repo.createSnapshot({ ownerUserId: 'user-1', ownerDisplayName: 'X', title: '', workspaceData: {}, graphCount: 0 });
  assert.equal(pool.calls[0].params[2], null);
});

test('listSnapshots selects metadata columns only, never workspace_data, newest first', async () => {
  const pool = createFakePool([snapshotRow()]);
  const repo = createWorkspaceSnapshotRepository(pool);
  const results = await repo.listSnapshots();
  assert.match(pool.calls[0].text, /SELECT id, owner_user_id, owner_display_name, title, graph_count, created_at/);
  assert.ok(!pool.calls[0].text.includes('workspace_data'), 'the browse-list query must never select the full JSONB payload');
  assert.match(pool.calls[0].text, /ORDER BY created_at DESC/);
  assert.equal(results[0].id, 'snap-1');
  assert.ok(!('workspaceData' in results[0]));
});

test('listSnapshots with no search adds no WHERE clause', async () => {
  const pool = createFakePool([]);
  const repo = createWorkspaceSnapshotRepository(pool);
  await repo.listSnapshots();
  assert.ok(!pool.calls[0].text.includes('WHERE'));
});

test('listSnapshots search matches owner_display_name OR title', async () => {
  const pool = createFakePool([]);
  const repo = createWorkspaceSnapshotRepository(pool);
  await repo.listSnapshots({ search: 'Tasmiya' });
  assert.match(pool.calls[0].text, /owner_display_name ILIKE \$1 OR title ILIKE \$1/);
  assert.equal(pool.calls[0].params[0], '%Tasmiya%');
});

test('listSnapshots clamps limit to MAX_LIST_LIMIT and defaults offset to 0', async () => {
  const pool = createFakePool([]);
  const repo = createWorkspaceSnapshotRepository(pool);
  await repo.listSnapshots({ limit: 99999 });
  const params = pool.calls[0].params;
  assert.equal(params[params.length - 2], 200);
  assert.equal(params[params.length - 1], 0);
});

test('getSnapshotById returns the full model including workspace_data', async () => {
  const pool = createFakePool([snapshotRow()]);
  const repo = createWorkspaceSnapshotRepository(pool);
  const result = await repo.getSnapshotById('snap-1');
  assert.match(pool.calls[0].text, /SELECT \* FROM workspace_snapshots WHERE id = \$1/);
  assert.deepEqual(pool.calls[0].params, ['snap-1']);
  assert.deepEqual(result.workspaceData, { sequences: [{ id: 'seq-1' }] });
});

test('getSnapshotById returns null when no snapshot has this id', async () => {
  const pool = createFakePool([]);
  const repo = createWorkspaceSnapshotRepository(pool);
  assert.equal(await repo.getSnapshotById('missing'), null);
});

test('deleteSnapshot deletes by id and reports whether a row actually existed', async () => {
  const pool = createFakePool([{ id: 'snap-1' }]);
  const repo = createWorkspaceSnapshotRepository(pool);
  const deleted = await repo.deleteSnapshot('snap-1');
  assert.match(pool.calls[0].text, /DELETE FROM workspace_snapshots WHERE id = \$1/);
  assert.equal(deleted, true);
});

test('deleteSnapshot returns false when no snapshot has this id', async () => {
  const pool = createFakePool([]);
  const repo = createWorkspaceSnapshotRepository(pool);
  assert.equal(await repo.deleteSnapshot('missing'), false);
});
