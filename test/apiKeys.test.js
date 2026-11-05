import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiKeyRegistry, hasScope, parseApiKeys } from '../src/security/apiKeys.js';
import { ValidationError } from '../src/errors.js';

const CI = 'ci-secret-0123456789';
const OPS = 'ops-secret-0123456789';

test('parses names, secrets and scopes that contain colons', () => {
  const keys = parseApiKeys(`ci:${CI}:links:read+links:write, ops:${OPS}:*`);
  assert.deepEqual(keys, [
    { name: 'ci', secret: CI, scopes: ['links:read', 'links:write'] },
    { name: 'ops', secret: OPS, scopes: ['*'] },
  ]);
  assert.deepEqual(parseApiKeys(''), []);
  assert.deepEqual(parseApiKeys(' , '), []);
});

test('rejects malformed key lists without echoing secrets', () => {
  const bad = [
    'just-a-name',
    `:${CI}:admin`,
    `bad name:${CI}:admin`,
    'ci:short:admin',
    `ci:${CI}:links:delete`,
    `ci:${CI}:`,
    `ci:${CI}:admin,ci:${OPS}:admin`,
    `a:${CI}:admin,b:${CI}:admin`,
  ];
  for (const spec of bad) {
    assert.throws(() => parseApiKeys(spec), (err) => {
      assert.ok(err instanceof ValidationError, spec);
      assert.ok(!err.message.includes(CI) && !err.message.includes(OPS), err.message);
      return true;
    });
  }
});

test('authenticates only exact secrets', () => {
  const registry = ApiKeyRegistry.fromSpec(`ci:${CI}:links:read,ops:${OPS}:*`);
  assert.equal(registry.size, 2);
  assert.deepEqual(registry.authenticate(CI), { name: 'ci', scopes: ['links:read'] });
  assert.equal(registry.authenticate(OPS)?.name, 'ops');
  for (const presented of [`${CI}x`, CI.slice(0, -1), CI.toUpperCase(), '', undefined, 42]) {
    assert.equal(registry.authenticate(presented), null);
  }
  assert.equal(new ApiKeyRegistry().authenticate(CI), null);
});

test('the registry does not retain plain-text secrets', () => {
  const registry = ApiKeyRegistry.fromSpec(`ci:${CI}:links:read`);
  assert.ok(!JSON.stringify(registry.entries).includes(CI));
});

test('hasScope honours explicit scopes and the wildcard', () => {
  const registry = ApiKeyRegistry.fromSpec(`ci:${CI}:links:read+stats:read,ops:${OPS}:*`);
  const ci = /** @type {import('../src/security/apiKeys.js').ApiKey} */ (registry.authenticate(CI));
  const ops = /** @type {import('../src/security/apiKeys.js').ApiKey} */ (registry.authenticate(OPS));
  assert.equal(hasScope(ci, 'links:read'), true);
  assert.equal(hasScope(ci, 'links:write'), false);
  assert.equal(hasScope(ci, 'admin'), false);
  assert.equal(hasScope(ops, 'admin'), true);
});
