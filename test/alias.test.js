import test from 'node:test';
import assert from 'node:assert/strict';
import { isReservedWord, validateAlias } from '../src/codes/alias.js';
import { ValidationError } from '../src/errors.js';

/** @param {() => unknown} fn @param {string} code */
function assertRejects(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.code, code);
    assert.equal(err.field, 'alias');
    return true;
  });
}

test('accepts well-formed aliases unchanged', () => {
  for (const alias of ['abc', 'My-Link_2026', 'a1b', 'x'.repeat(32)]) {
    assert.equal(validateAlias(alias), alias);
  }
});

test('rejects aliases of the wrong type or length', () => {
  assertRejects(() => validateAlias(42), 'alias_invalid');
  assertRejects(() => validateAlias('ab'), 'alias_length');
  assertRejects(() => validateAlias('x'.repeat(33)), 'alias_length');
  assert.equal(validateAlias('ab', { minLength: 2 }), 'ab');
});

test('rejects characters that are unsafe in a path segment', () => {
  for (const alias of ['has space', 'sla/sh', 'dot.dot', 'quer?y', 'ünïcode', 'per%20cent']) {
    assertRejects(() => validateAlias(alias), 'alias_invalid');
  }
});

test('requires an alphanumeric first and last character', () => {
  for (const alias of ['-abc', 'abc-', '_abc', 'abc_']) {
    assertRejects(() => validateAlias(alias), 'alias_invalid');
  }
});

test('reserved words are rejected regardless of case', () => {
  assertRejects(() => validateAlias('api'), 'alias_reserved');
  assertRejects(() => validateAlias('Admin'), 'alias_reserved');
  assertRejects(() => validateAlias('HEALTHZ'), 'alias_reserved');
  assert.equal(validateAlias('apiary'), 'apiary');
  assert.equal(isReservedWord('Docs'), true);
  assert.equal(isReservedWord('docs2'), false);
  assertRejects(() => validateAlias('promo', { reserved: ['promo'] }), 'alias_reserved');
});
