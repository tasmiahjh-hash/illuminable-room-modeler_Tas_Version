import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../server/auth/passwordHashing.js';

test('hashPassword never returns the plaintext itself', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.notEqual(hash, 'correct horse battery staple');
  assert.ok(hash.length > 20);
});

test('verifyPassword returns true for the correct password against its own hash', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
});

test('verifyPassword returns false for an incorrect password', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('hashPassword produces a different hash each time (random salt), even for the same input', async () => {
  const hashA = await hashPassword('same password');
  const hashB = await hashPassword('same password');
  assert.notEqual(hashA, hashB);
  // Both must still verify correctly despite differing.
  assert.equal(await verifyPassword('same password', hashA), true);
  assert.equal(await verifyPassword('same password', hashB), true);
});
