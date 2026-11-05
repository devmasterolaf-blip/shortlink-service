import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, isPasswordHash, needsRehash, verifyPassword } from '../src/security/password.js';

const FAST = { N: 1024, r: 8, p: 1 };

test('hash verifies only with the right password', async () => {
  const encoded = await hashPassword('correct horse', FAST);
  assert.match(encoded, /^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword('correct horse', encoded), true);
  assert.equal(await verifyPassword('correct horsf', encoded), false);
  assert.equal(await verifyPassword('', encoded), false);
});

test('each hash uses a fresh salt', async () => {
  const [a, b] = await Promise.all([hashPassword('same', FAST), hashPassword('same', FAST)]);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same', a), true);
  assert.equal(await verifyPassword('same', b), true);
});

test('unicode passwords are compared in normalised form', async () => {
  const encoded = await hashPassword('café', FAST);
  assert.equal(await verifyPassword('café', encoded), true);
});

test('malformed or hostile hashes verify as false', async () => {
  const good = await hashPassword('pw', FAST);
  const [, , , , salt, key] = good.split('$');
  const bad = [
    '',
    'plaintext',
    'bcrypt$10$abc',
    `scrypt$1000$8$1$${salt}$${key}`,
    `scrypt$${2 ** 30}$8$1$${salt}$${key}`,
    `scrypt$1024$8$1$$${key}`,
    `scrypt$1024$8$1$${salt}$`,
  ];
  for (const encoded of bad) {
    assert.equal(await verifyPassword('pw', encoded), false, encoded);
    assert.equal(isPasswordHash(encoded), false, encoded);
  }
  assert.equal(isPasswordHash(good), true);
  assert.equal(await verifyPassword('pw', /** @type {any} */ (null)), false);
});

test('hashPassword rejects empty input', async () => {
  await assert.rejects(hashPassword('', FAST), TypeError);
  await assert.rejects(hashPassword(/** @type {any} */ (undefined), FAST), TypeError);
});

test('needsRehash flags weaker parameters', async () => {
  const weak = await hashPassword('pw', FAST);
  assert.equal(needsRehash(weak, FAST), false);
  assert.equal(needsRehash(weak, { N: 2048, r: 8, p: 1 }), true);
  assert.equal(needsRehash('garbage', FAST), true);
});
