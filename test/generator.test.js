import test from 'node:test';
import assert from 'node:assert/strict';
import { CounterCodeGenerator, RandomCodeGenerator } from '../src/codes/generator.js';
import { CodePermutation, isBase62 } from '../src/codes/base62.js';
import { MemoryStore } from '../src/storage/memoryStore.js';

test('counter generator yields distinct codes backed by the store sequence', () => {
  const store = new MemoryStore();
  const generator = new CounterCodeGenerator({ store, permutation: new CodePermutation({ minLength: 3 }) });
  const codes = new Set();
  for (let i = 0; i < 500; i++) codes.add(generator.next());
  assert.equal(codes.size, 500);
  assert.ok([...codes].every((code) => code.length === 3 && isBase62(code)));
  assert.equal(store.nextSequence(), 500);
});

test('two counter generators on one store continue the same sequence', () => {
  const store = new MemoryStore();
  const permutation = new CodePermutation({ minLength: 4 });
  const first = new CounterCodeGenerator({ store, permutation });
  const second = new CounterCodeGenerator({ store, permutation });
  assert.equal(first.next(), permutation.encode(0));
  assert.equal(second.next(), permutation.encode(1));
});

test('random generator uses the injected source and the requested length', () => {
  const picks = [0, 10, 36, 61];
  let calls = 0;
  const generator = new RandomCodeGenerator({ length: 4, randomInt: (max) => {
    assert.equal(max, 62);
    return picks[calls++ % picks.length];
  } });
  assert.equal(generator.next(), '0Aaz');
});

test('random generator lengthens codes after repeated rejections', () => {
  const generator = new RandomCodeGenerator({ length: 5, escalateEvery: 2 });
  assert.deepEqual([0, 1, 2, 3, 4].map((attempt) => generator.next(attempt).length), [5, 5, 6, 6, 7]);
  assert.ok(isBase62(generator.next()));
});

test('random generator validates options', () => {
  assert.throws(() => new RandomCodeGenerator({ length: 0 }), RangeError);
  assert.throws(() => new RandomCodeGenerator({ escalateEvery: 0 }), RangeError);
});
