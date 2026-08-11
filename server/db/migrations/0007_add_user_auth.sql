-- Research Database System (RDS) Phase 1: real authentication. Adds the
-- columns 0001_create_users.sql explicitly left for "once a real auth
-- system is added" — email/password sign-in and a role (Research User vs
-- Admin; Guest is never a users row at all, see server/auth/requireAuth.js's
-- own comment). All additive so existing rows (today, none have a
-- password) stay valid; application code (not this constraint) requires
-- both email and password_hash for any row created via the new signup
-- route.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'research_user',
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Added as a separate statement (not inline on the column above) so this
-- migration stays valid to re-run against a database that already has the
-- column but not yet the constraint, matching this migration runner's own
-- "IF NOT EXISTS" idempotency convention as closely as CHECK constraints
-- allow (Postgres has no "ADD CONSTRAINT IF NOT EXISTS", so this guards
-- with a catalog lookup instead).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('research_user', 'admin'));
  END IF;
END $$;
