// MessageRepository: the ONLY module allowed to execute SQL against
// `user_messages` — mirrors graphRepository.js/userRepository.js's own
// hard rule and factory pattern. Backs the Admin Dashboard's "Message
// User" and "Push Update" actions (see the RDS plan's own confirmed
// decision: an in-app inbox, not email — no notification/mail service
// exists anywhere in this project).

import { getPool } from '../db/pool.js';

const messageRowToModel = (row) => ({
  id: row.id,
  userId: row.user_id,
  senderAdminId: row.sender_admin_id,
  messageType: row.message_type,
  body: row.body,
  relatedGraphId: row.related_graph_id,
  readAt: row.read_at,
  createdAt: row.created_at,
});

/** Builds a MessageRepository bound to `pool`. */
export const createMessageRepository = (pool) => ({
  /** Sends a message to a user's inbox. `messageType` is 'admin_message' | 'graph_repaired' | 'push_update'. */
  async createMessage({ userId, senderAdminId = null, messageType, body, relatedGraphId = null }) {
    const { rows } = await pool.query(
      `INSERT INTO user_messages (user_id, sender_admin_id, message_type, body, related_graph_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, senderAdminId, messageType, body, relatedGraphId],
    );
    return messageRowToModel(rows[0]);
  },

  /** Every message for one user's own inbox, newest first. */
  async listMessagesForUser(userId) {
    const { rows } = await pool.query('SELECT * FROM user_messages WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return rows.map(messageRowToModel);
  },

  /** Marks one message read — scoped to userId so a user can never mark (or even address) another user's message by guessing an id. Returns the updated model, or null if no matching message exists. */
  async markMessageRead(id, userId) {
    const { rows } = await pool.query(
      'UPDATE user_messages SET read_at = now() WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, userId],
    );
    return rows[0] ? messageRowToModel(rows[0]) : null;
  },
});

let sharedRepository = null;

/** The repository bound to the real shared pool (server/db/pool.js). */
export const getMessageRepository = async () => {
  if (!sharedRepository) sharedRepository = createMessageRepository(await getPool());
  return sharedRepository;
};
