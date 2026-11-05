import test from 'node:test';
import assert from 'node:assert/strict';
import { CodePermutation, decodeBase62, encodeBase62, isBase62 } from '../src/codes/base62.js';

test('encodeBase62 covers digits, upper and lower case', () => {
  assert.equal(encodeBase62(0), '0');
  assert.equal(encodeBase62(9), '9');
  assert.equal(encodeBase62(10), 'A');
  assert.equal(encodeBase62(35), 'Z');
  assert.equal(encodeBase62(36), 'a');
  assert.equal(encodeBase62(61), 'z');
  assert.equal(encodeBase62(62), '10');
  assert.equal(encodeBase62(5, 4), '0005');
});

test('base62 round-trips large values', () => {
  for (const n of [0n, 1n, 61n, 62n, 3843n, 2n ** 64n - 1n, 62n ** 11n + 7n]) {
    assert.equal(decodeBase62(encodeBase62(n)), n);
  }
});

test('base62 rejects bad input', () => {
  assert.throws(() => encodeBase62(-1), RangeError);
  assert.throws(() => encodeBase62(1.5), RangeError);
  assert.throws(() => decodeBase62(''), TypeError);
  assert.throws(() => decodeBase62('ab-c'), RangeError);
  assert.equal(isBase62('aZ09'), true);
  assert.equal(isBase62('a_b'), false);
  assert.equal(isBase62(''), false);
});

test('permutation is a bijection over a whole tier', () => {
  const perm = new CodePermutation({ minLength: 2, maxLength: 3 });
  const seen = new Set();
  for (let i = 0; i < 62 ** 2; i++) {
    const code = perm.encode(i);
    assert.equal(code.length, 2);
    seen.add(code);
  }
  assert.equal(seen.size, 62 ** 2);
});

test('permutation grows the code length when a tier is exhausted', () => {
  const perm = new CodePermutation({ minLength: 1, maxLength: 3 });
  assert.equal(perm.encode(61).length, 1);
  assert.equal(perm.encode(62).length, 2);
  assert.equal(perm.encode(62 + 62 ** 2 - 1).length, 2);
  assert.equal(perm.encode(62 + 62 ** 2).length, 3);
  assert.equal(perm.capacity, 62n + 62n ** 2n + 62n ** 3n);
  assert.throws(() => perm.encode(perm.capacity), RangeError);
});

test('permutation decode inverts encode across tiers', () => {
  const perm = new CodePermutation({ minLength: 3, maxLength: 6, secret: 'unit-test' });
  for (const n of [0n, 1n, 2n, 238327n, 238328n, 15018570n, 62n ** 5n + 12345n]) {
    assert.equal(perm.decode(perm.encode(n)), n);
  }
  assert.throws(() => perm.decode('ab'), RangeError);
});

test('consecutive counters do not produce consecutive codes', () => {
  const perm = new CodePermutation({ minLength: 5 });
  const a = decodeBase62(perm.encode(100));
  const b = decodeBase62(perm.encode(101));
  const distance = a > b ? a - b : b - a;
  assert.ok(distance > 1000n, `codes are only ${distance} apart`);
});

test('secret selects a different, still valid permutation', () => {
  const one = new CodePermutation({ secret: 'alpha' });
  const two = new CodePermutation({ secret: 'beta' });
  assert.notEqual(one.encode(1), two.encode(1));
  assert.equal(one.encode(1), new CodePermutation({ secret: 'alpha' }).encode(1));
  assert.equal(one.multiplier % 2n, 1n);
  assert.notEqual(one.multiplier % 31n, 0n);
});

test('permutation validates its parameters', () => {
  assert.throws(() => new CodePermutation({ minLength: 0 }), RangeError);
  assert.throws(() => new CodePermutation({ minLength: 5, maxLength: 4 }), RangeError);
  assert.throws(() => new CodePermutation({ multiplier: 62n }), RangeError);
  assert.throws(() => new CodePermutation({ multiplier: 31n }), RangeError);
});
