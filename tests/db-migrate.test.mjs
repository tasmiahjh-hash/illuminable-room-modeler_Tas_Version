import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { listMigrationFiles, runMigrations } from '../server/db/migrate.js';

const MIGRATIONS_DIR = path.join(process.cwd(), 'server', 'db', 'migrations');

// A fake pool that understands just enough of runMigrations's own SQL
// (the schema_migrations bookkeeping) to behave like a real one would,
// without any actual database — every other query (the migration files'
// own CREATE TABLE statements) is simply recorded, not interpreted.
const createFakePool = (alreadyApplied = []) => {
  const applied = new Set(alreadyApplied);
  const executedSql = [];
  return {
    applied,
    executedSql,
    query: async (text, params) => {
      executedSql.push(text);
      if (/SELECT name FROM schema_migrations/.test(text)) {
        return { rows: [...applied].map((name) => ({ name })) };
      }
      if (/INSERT INTO schema_migrations/.test(text)) {
        applied.add(params[0]);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
};

const ALL_MIGRATIONS = [
  '0001_create_users.sql',
  '0002_create_graphs.sql',
  '0003_create_graph_geometry.sql',
  '0004_create_graph_jobs.sql',
  '0005_add_graph_usage_tracking.sql',
  '0006_add_graph_search_indexes.sql',
  '0007_add_user_auth.sql',
  '0008_add_graph_metadata_columns.sql',
  '0009_create_graph_versions.sql',
  '0010_create_sync_state.sql',
  '0011_create_user_messages.sql',
  '0012_add_user_last_seen.sql',
  '0013_create_graph_shares.sql',
  '0014_create_workspace_snapshots.sql',
];

test('listMigrationFiles returns every .sql file in filename order', () => {
  const files = listMigrationFiles(MIGRATIONS_DIR);
  assert.deepEqual(files, ALL_MIGRATIONS);
});

test('runMigrations applies every migration, in order, on a fresh database', async () => {
  const pool = createFakePool();
  const applied = await runMigrations(pool, MIGRATIONS_DIR);
  assert.deepEqual(applied, ALL_MIGRATIONS);
});

test('runMigrations actually runs each file\'s own SQL content, not just tracks its name', async () => {
  const pool = createFakePool();
  await runMigrations(pool, MIGRATIONS_DIR);
  const usersSql = readFileSync(path.join(MIGRATIONS_DIR, '0001_create_users.sql'), 'utf8');
  assert.ok(pool.executedSql.includes(usersSql), 'the migration file\'s exact SQL text must have been executed');
});

test('runMigrations skips already-applied migrations and only runs the rest', async () => {
  const pool = createFakePool(['0001_create_users.sql', '0002_create_graphs.sql']);
  const applied = await runMigrations(pool, MIGRATIONS_DIR);
  assert.deepEqual(applied, ALL_MIGRATIONS.slice(2));
});

test('running runMigrations again after everything is applied is a no-op', async () => {
  const pool = createFakePool();
  await runMigrations(pool, MIGRATIONS_DIR);
  const secondRun = await runMigrations(pool, MIGRATIONS_DIR);
  assert.deepEqual(secondRun, []);
});

test('runMigrations records each applied migration in schema_migrations exactly once', async () => {
  const pool = createFakePool();
  await runMigrations(pool, MIGRATIONS_DIR);
  assert.deepEqual([...pool.applied].sort(), [...ALL_MIGRATIONS].sort());
});
