-- Admin "Push Graph to User" (RDS Admin Dashboard). graphs.hash is
-- globally UNIQUE (see 0001/graphRepository.js's own upsertGraph) — a
-- graph's row *is* its content identity, so "pushing a copy" can never mean
-- inserting a second row with the same params, and reassigning
-- owner_user_id would silently steal the graph from whoever created it
-- (explicitly forbidden: "Do NOT modify the original graph"). A grant
-- table instead: pushing a graph to a user makes it additionally visible
-- to them (see server/api/app.js's own visibleToUserId filter) without
-- touching the original row at all. UNIQUE(graph_id, recipient_user_id) is
-- also what "avoid duplicates" means here — pushing the same graph to the
-- same user twice is a no-op (ON CONFLICT DO NOTHING in
-- graphRepository.js's pushGraphToUser), never a second row or a second
-- inbox notification.
CREATE TABLE IF NOT EXISTS graph_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id UUID NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pushed_by_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (graph_id, recipient_user_id)
);

CREATE INDEX IF NOT EXISTS graph_shares_recipient_idx ON graph_shares(recipient_user_id);
