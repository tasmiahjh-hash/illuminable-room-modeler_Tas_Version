-- Cloud Workspace Library: "Save All" persists the caller's ENTIRE current
-- workspace (every sequence row plus the surrounding view/global settings —
-- the exact same shape App.jsx's own buildWorkspaceSnapshot/WorkspaceManager
-- already builds for local autosave, see workspaceManager.js's own module
-- comment) as one immutable, dated snapshot. Every Save All creates a NEW
-- row here — never an UPDATE — so a user's own history of past saves is
-- preserved (no updated_at column: nothing here is ever mutated after
-- insert, except an admin/owner delete).
--
-- workspace_data is JSONB, not a normalized set of graph rows: a snapshot
-- can hold anywhere from one to thousands of sequence rows, and nothing
-- in this app ever queries "find graphs across snapshots by their own
-- fields" (that's what the existing, separate `graphs` table/Graph
-- Library already does) — storing the whole blob avoids normalizing
-- hundreds of ad-hoc rows for data that's only ever read back whole, by
-- its own owner or another user's explicit Load.
--
-- owner_display_name is denormalized (stamped at save time), mirroring
-- graphs.owner_name's own precedent (see 0008's comment) — the library
-- lists/groups by name without a join, and a snapshot correctly keeps
-- showing the name the owner had *when they saved it* even if their
-- account's display_name changes later.
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_display_name TEXT NOT NULL,
  -- Optional, user-supplied at Save All time (e.g. "Testing long ABC
  -- sequences"); null when left blank — the library falls back to
  -- displaying just the date/time in that case.
  title TEXT,
  workspace_data JSONB NOT NULL,
  -- Denormalized from workspace_data's own sequences array length at save
  -- time, so the metadata-only list endpoint (see workspaceSnapshotRepository.js's
  -- own listSnapshots) never has to parse the JSONB just to show a count.
  graph_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backs both "my own saves, newest first" and the library's own
-- "grouped by user" browse view.
CREATE INDEX IF NOT EXISTS workspace_snapshots_owner_created_idx ON workspace_snapshots(owner_user_id, created_at DESC);
-- Backs the library's own global newest-first listing across every user.
CREATE INDEX IF NOT EXISTS workspace_snapshots_created_idx ON workspace_snapshots(created_at DESC);
