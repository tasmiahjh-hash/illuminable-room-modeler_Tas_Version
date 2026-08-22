import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceAutosaveRepository } from '../server/repositories/workspaceAutosaveRepository.js';

// A fake pool that actually behaves like the real conditional UPSERT this
// repository depends on — a plain fake returning a fixed row set (the
// pattern every other *Repository test file uses) can't exercise the
// "the WHERE clause rejected this write" branch realistically, since that
// behavior lives in Postgres itself, not in this file's own JS. This fake
// keeps one in-memory row per owner_user_id and actually evaluates the
// same client_revision <= EXCLUDED.client_revision condition the real
// migration's ON CONFLICT clause does, so upsertAutosave's own "applied
// vs rejected-as-stale" branching gets real, meaningful coverage.
const createFakePool = () => {
  const rowsByOwner = new Map();
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (text.includes('INSERT INTO workspace_autosaves')) {
        const [ownerUserId, workspaceDataJson, clientRevision] = params;
        const existing = rowsByOwner.get(ownerUserId);
        if (existing && Number(existing.client_revision) > Number(clientRevision)) {
          return { rows: [] }; // WHERE clause rejected — stale write.
        }
        const row = {
          owner_user_id: ownerUserId, workspace_data: JSON.parse(workspaceDataJson),
          client_revision: clientRevision, updated_at: new Date().toISOString(),
        };
        rowsByOwner.set(ownerUserId, row);
        return { rows: [row] };
      }
      if (text.includes('SELECT * FROM workspace_autosaves WHERE owner_user_id')) {
        const row = rowsByOwner.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      throw new Error(`unexpected query in fake pool: ${text}`);
    },
  };
};

test('getAutosave returns null when this user has never saved one', async () => {
  const repo = createWorkspaceAutosaveRepository(createFakePool());
  assert.equal(await repo.getAutosave('user-1'), null);
});

test('upsertAutosave creates the first row for a user, applied:true', async () => {
  const repo = createWorkspaceAutosaveRepository(createFakePool());
  const result = await repo.upsertAutosave({ ownerUserId: 'user-1', workspaceData: { sequences: [{ id: 's1' }] }, clientRevision: 1 });
  assert.equal(result.applied, true);
  assert.deepEqual(result.autosave.workspaceData, { sequences: [{ id: 's1' }] });
  assert.equal(result.autosave.clientRevision, 1);
  assert.equal(result.autosave.ownerUserId, 'user-1');
});

test('upsertAutosave overwrites the existing row (never creates a second one) when the new revision is higher', async () => {
  const pool = createFakePool();
  const repo = createWorkspaceAutosaveRepository(pool);
  await repo.upsertAutosave({ ownerUserId: 'user-1', workspaceData: { sequences: [{ id: 's1' }] }, clientRevision: 1 });
  const result = await repo.upsertAutosave({ ownerUserId: 'user-1', workspaceData: { sequences: [{ id: 's1' }, { id: 's2' }] }, clientRevision: 2 });
  assert.equal(result.applied, true);
  assert.deepEqual(result.autosave.workspaceData, { sequences: [{ id: 's1' }, { id: 's2' }] });
  assert.equal(result.autosave.clientRevision, 2);
});

test('a stale (lower-revision) upsertAutosave is rejected and never overwrites the newer stored state — the core race-safety guarantee', async () => {
  const pool = createFakePool();
  const repo = createWorkspaceAutosaveRepository(pool);
  // Simulates Device B saving revision 5 (further along), then Device A's
  // own older, out-of-order revision-2 request arriving late.
  await repo.upsertAutosave({ ownerUserId: 'user-1', workspaceData: { sequences: [{ id: 'from-device-B' }] }, clientRevision: 5 });
  const staleResult = await repo.upsertAutosave({ ownerUserId: 'user-1', workspaceData: { sequences: [{ id: 'stale-from-device-A' }] }, clientRevision: 2 });

  assert.equal(staleResult.applied, false, 'a lower client_revision must never be applied over a higher one already stored');
  assert.deepEqual(staleResult.autosave.workspaceData, { sequences: [{ id: 'from-device-B' }] }, 'the reported current state must still be the newer (Device B) data, untouched by the stale write');

  const stored = await repo.getAutosave('user-1');
  assert.deepEqual(stored.workspaceData, { sequences: [{ id: 'from-device-B' }] }, 'the actual stored row must remain Device B\'s newer state');
  assert.equal(stored.clientRevision, 5);
});

test('a retry with the exact same revision is accepted (idempotent retry), not treated as stale', async () => {
  const pool = createFakePool();
  const repo = createWorkspaceAutosaveRepository(pool);
  await repo.upsertAutosave({ ownerUserId: 'user-1', workspaceData: { sequences: [{ id: 'v1' }] }, clientRevision: 3 });
  const retry = await repo.upsertAutosave({ ownerUserId: 'user-1', workspaceData: { sequences: [{ id: 'v1-retry' }] }, clientRevision: 3 });
  assert.equal(retry.applied, true);
});

test('two different users never share or overwrite each other\'s autosave rows', async () => {
  const pool = createFakePool();
  const repo = createWorkspaceAutosaveRepository(pool);
  await repo.upsertAutosave({ ownerUserId: 'user-a', workspaceData: { sequences: [{ id: 'a1' }] }, clientRevision: 1 });
  await repo.upsertAutosave({ ownerUserId: 'user-b', workspaceData: { sequences: [{ id: 'b1' }] }, clientRevision: 1 });

  const aAutosave = await repo.getAutosave('user-a');
  const bAutosave = await repo.getAutosave('user-b');
  assert.deepEqual(aAutosave.workspaceData, { sequences: [{ id: 'a1' }] });
  assert.deepEqual(bAutosave.workspaceData, { sequences: [{ id: 'b1' }] });
});
