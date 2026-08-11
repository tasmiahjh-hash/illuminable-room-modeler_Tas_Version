-- RDS Phase 1: brings `graphs` up to parity with the fields
-- src/graphLibrary/browserGraphDatabaseStore.js already stores per-graph
-- locally (title/description/tags/favorite/visibility/notes/color/
-- maxBounces), so a graph synced to this table in a later phase doesn't
-- lose any of them. All additive with safe defaults — existing rows (today
-- none have these columns populated) stay valid.
ALTER TABLE graphs
  ADD COLUMN IF NOT EXISTS owner_name TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS max_bounces INTEGER,
  ADD COLUMN IF NOT EXISTS graph_color_hex TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS favorite BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
  -- Bumped on every content-changing sync/edit — the "never overwrite
  -- newer work" rule a later sync-engine phase enforces compares this
  -- number, not wall-clock timestamps (clock skew across a researcher's
  -- own devices makes timestamp-only conflict resolution unreliable).
  ADD COLUMN IF NOT EXISTS current_version INTEGER NOT NULL DEFAULT 1,
  -- Soft delete: an admin "delete" must be restorable (see the spec's own
  -- "restore graphs"), so this is never a real DELETE FROM graphs.
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'graphs_visibility_check'
  ) THEN
    ALTER TABLE graphs ADD CONSTRAINT graphs_visibility_check CHECK (visibility IN ('private', 'shared', 'public'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS graphs_owner_visibility_idx ON graphs(owner_user_id, visibility);
CREATE INDEX IF NOT EXISTS graphs_tags_idx ON graphs USING GIN(tags);
