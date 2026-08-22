-- Cloud Autosave: ONE continuously-updated "current workspace" row per
-- account — completely distinct from workspace_snapshots (Save All's own
-- table), which is many *immutable, dated* rows per account. Every
-- autosave here OVERWRITES the same row (upsert on owner_user_id, the
-- primary key itself, since the relationship is inherently 1:1 — there is
-- no separate surrogate id to keep in sync with "the one row for this
-- user"), so it always reflects "where this account last left off,"
-- restorable on any device/browser after signing in.
--
-- client_revision is what makes "an older autosave request cannot
-- overwrite a newer workspace state" (this feature's own explicit
-- requirement) enforceable atomically in the database itself, not just by
-- hoping requests arrive in order — see workspaceAutosaveRepository.js's
-- own upsertAutosave, whose ON CONFLICT ... WHERE clause only applies an
-- incoming write when its own client_revision is >= what's already
-- stored. The browser's own monotonically-increasing counter (never a
-- wall-clock timestamp — clock skew across a user's own devices would
-- make timestamp-only ordering unreliable) is what gets compared.
CREATE TABLE IF NOT EXISTS workspace_autosaves (
  owner_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  workspace_data JSONB NOT NULL,
  client_revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
