import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageRepository } from '../server/repositories/messageRepository.js';

// Fake pool mirrors tests/graph-repository.test.mjs / tests/user-repository.test.mjs's own pattern.
const createFakePool = (rows = []) => {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows };
    },
  };
};

const messageRow = (overrides = {}) => ({
  id: 'msg-1', user_id: 'user-1', sender_admin_id: 'admin-1', message_type: 'admin_message',
  body: 'Hello', related_graph_id: null, read_at: null, created_at: 'created-x',
  ...overrides,
});

test('createMessage inserts and maps the returned row to the public message model', async () => {
  const row = messageRow();
  const pool = createFakePool([row]);
  const repo = createMessageRepository(pool);

  const message = await repo.createMessage({ userId: 'user-1', senderAdminId: 'admin-1', messageType: 'admin_message', body: 'Hello' });

  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /INSERT INTO user_messages/);
  assert.deepEqual(pool.calls[0].params, ['user-1', 'admin-1', 'admin_message', 'Hello', null]);
  assert.deepEqual(message, {
    id: 'msg-1', userId: 'user-1', senderAdminId: 'admin-1', messageType: 'admin_message',
    body: 'Hello', relatedGraphId: null, readAt: null, createdAt: 'created-x',
  });
});

test('createMessage defaults senderAdminId and relatedGraphId to null', async () => {
  const pool = createFakePool([messageRow({ sender_admin_id: null })]);
  const repo = createMessageRepository(pool);
  await repo.createMessage({ userId: 'user-1', messageType: 'push_update', body: 'Update' });
  assert.deepEqual(pool.calls[0].params, ['user-1', null, 'push_update', 'Update', null]);
});

test('listMessagesForUser selects by user_id, newest first', async () => {
  const pool = createFakePool([messageRow(), messageRow({ id: 'msg-2' })]);
  const repo = createMessageRepository(pool);

  const messages = await repo.listMessagesForUser('user-1');

  assert.match(pool.calls[0].text, /SELECT \* FROM user_messages WHERE user_id = \$1 ORDER BY created_at DESC/);
  assert.deepEqual(pool.calls[0].params, ['user-1']);
  assert.equal(messages.length, 2);
});

test('markMessageRead scopes the UPDATE to both the message id and the owning user id', async () => {
  const pool = createFakePool([messageRow({ read_at: 'now-x' })]);
  const repo = createMessageRepository(pool);
  const message = await repo.markMessageRead('msg-1', 'user-1');
  assert.match(pool.calls[0].text, /UPDATE user_messages SET read_at = now\(\) WHERE id = \$1 AND user_id = \$2/);
  assert.deepEqual(pool.calls[0].params, ['msg-1', 'user-1']);
  assert.equal(message.readAt, 'now-x');
});

test('markMessageRead returns null when no message matches (wrong id, or owned by a different user)', async () => {
  const pool = createFakePool([]);
  const repo = createMessageRepository(pool);
  assert.equal(await repo.markMessageRead('msg-1', 'someone-elses-id'), null);
});
