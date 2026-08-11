-- RDS: per-user background-sync bookkeeping — backs the Admin Dashboard's
-- "Last Sync"/"Online Status" columns and the Graph Database Browser's own
-- "Sync Status" indicator in a later phase. Not written or read by
-- anything in this pass.
CREATE TABLE IF NOT EXISTS user_sync_state (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_synced_at TIMESTAMPTZ,
  last_sync_status TEXT,
  device_count INTEGER NOT NULL DEFAULT 0
);
