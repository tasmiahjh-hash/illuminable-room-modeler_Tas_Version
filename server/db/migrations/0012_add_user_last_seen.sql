-- RDS Admin Dashboard: "Online Status" needs some presence signal, which a
-- stateless JWT design doesn't provide natively. Minimal heuristic: touch
-- this column on every authenticated request (see requireAuth.js), and the
-- dashboard reports "online" as "seen in the last few minutes" — distinct
-- from last_login_at (0007), which only updates once per sign-in, not on
-- every request, and so is a poor proxy for "currently active."
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
