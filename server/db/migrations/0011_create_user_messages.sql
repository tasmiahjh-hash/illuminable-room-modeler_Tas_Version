-- RDS: in-app inbox backing the Admin Dashboard's "Message User" and
-- "Push Update" actions (no email/notification service exists in this
-- project — see the plan's own confirmed decision to use an in-app inbox
-- instead of adding one). Not written or read by anything in this pass.
CREATE TABLE IF NOT EXISTS user_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- 'admin_message' | 'graph_repaired' | 'push_update'
  message_type TEXT NOT NULL,
  body TEXT NOT NULL,
  related_graph_id UUID REFERENCES graphs(id) ON DELETE SET NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_messages_user_id_idx ON user_messages(user_id, created_at DESC);
