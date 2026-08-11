-- RDS: version history. Every graph keeps a full metadata+geometry
-- snapshot per version (not a diff — same "never recompute, always redraw
-- instantly" principle graph_geometry already applies to the live/current
-- geometry) so a restore never needs to recompute anything either. Admin
-- repairs and user restores both record a new row here; nothing reads or
-- writes this table yet in this pass — it exists now so a later phase
-- (sync/restore UI) is additive, not another schema migration.
CREATE TABLE IF NOT EXISTS graph_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id UUID NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  graph_color_hex TEXT,
  visibility TEXT NOT NULL,
  favorite BOOLEAN NOT NULL,
  points JSONB NOT NULL,
  point_count INTEGER NOT NULL,
  -- 'user_edit' | 'admin_repair' | 'import' | 'restore' | 'initial'
  change_reason TEXT NOT NULL,
  changed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (graph_id, version_number)
);

CREATE INDEX IF NOT EXISTS graph_versions_graph_id_idx ON graph_versions(graph_id, version_number DESC);
