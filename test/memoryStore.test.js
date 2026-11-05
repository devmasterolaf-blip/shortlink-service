import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/storage/memoryStore.js';
import { ConflictError, NotFoundError } from '../src/errors.js';

/** @param {Partial<import('../src/storage/memoryStore.js').Link>} [over] */
function makeLink(over = {}) {
  return {
    code: 'abc1',
    url: 'https://example.com/',
    custom: false,
    createdAt: 1000,
    updatedAt: 1000,
    expiresAt: null,
    maxClicks: null,
    clicks: 0,
    lastClickAt: null,
    passwordHash: null,
    enabled: true,
    tags: ['a'],
    redirectType: /** @type {302} */ (302),
    ...over,
  };
}

test('sequence starts at zero and increases', () => {
  const store = new MemoryStore();
  assert.deepEqual([store.nextSequence(), store.nextSequence(), store.nextSequence()], [0, 1, 2]);
});

test('insert, get, list and count', () => {
  const store = new MemoryStore();
  store.insertLink(makeLink());
  store.insertLink(makeLink({ code: 'zzz9' }));
  assert.equal(store.hasLink('abc1'), true);
  assert.equal(store.hasLink('ABC1'), false);
  assert.equal(store.getLink('abc1')?.url, 'https://example.com/');
  assert.equal(store.getLink('nope'), undefined);
  assert.deepEqual(store.listLinks().map((link) => link.code), ['abc1', 'zzz9']);
  assert.equal(store.countLinks(), 2);
});

test('insert rejects duplicate codes', () => {
  const store = new MemoryStore();
  store.insertLink(makeLink());
  assert.throws(() => store.insertLink(makeLink({ url: 'https://other.example/' })), (err) => {
    assert.ok(err instanceof ConflictError);
    assert.equal(err.code, 'code_taken');
    return true;
  });
  assert.equal(store.getLink('abc1')?.url, 'https://example.com/');
});

test('returned links are copies, not live references', () => {
  const store = new MemoryStore();
  const input = makeLink();
  store.insertLink(input);
  input.tags.push('mutated');
  const fetched = store.getLink('abc1');
  fetched?.tags.push('also-mutated');
  store.listLinks()[0].url = 'https://evil.example/';
  assert.deepEqual(store.getLink('abc1')?.tags, ['a']);
  assert.equal(store.getLink('abc1')?.url, 'https://example.com/');
});

test('update merges a patch and cannot change the code', () => {
  const store = new MemoryStore();
  store.insertLink(makeLink());
  const updated = store.updateLink('abc1', { enabled: false, code: 'hijack', tags: ['x', 'y'] });
  assert.equal(updated.code, 'abc1');
  assert.equal(updated.enabled, false);
  assert.deepEqual(store.getLink('abc1')?.tags, ['x', 'y']);
  assert.equal(store.hasLink('hijack'), false);
  assert.throws(() => store.updateLink('nope', {}), NotFoundError);
});

test('delete removes the link together with its statistics', () => {
  const store = new MemoryStore();
  store.insertLink(makeLink());
  store.recordClick({ code: 'abc1', at: 5000, referrer: '(direct)', userAgent: 'Chrome', visitor: 'v' });
  assert.equal(store.deleteLink('abc1'), true);
  assert.equal(store.deleteLink('abc1'), false);
  assert.equal(store.getStats('abc1'), undefined);
  store.insertLink(makeLink());
  assert.equal(store.getStats('abc1')?.total, 0);
});

test('recordClick updates the link counters and the aggregates', () => {
  const store = new MemoryStore();
  store.insertLink(makeLink());
  const at = Date.parse('2026-02-01T10:00:00Z');
  store.recordClick({ code: 'abc1', at, referrer: 'a.example', userAgent: 'Firefox', visitor: 'v1' });
  store.recordClick({ code: 'abc1', at: at + 5, referrer: 'a.example', userAgent: 'Firefox', visitor: 'v1' });
  store.recordClick({ code: 'missing', at, referrer: 'a.example', userAgent: 'Firefox', visitor: 'v1' });
  const link = store.getLink('abc1');
  assert.equal(link?.clicks, 2);
  assert.equal(link?.lastClickAt, at + 5);
  assert.deepEqual(store.getStats('abc1'), {
    total: 2,
    days: { '2026-02-01': { clicks: 2, visitors: ['v1'] } },
    referrers: { 'a.example': 2 },
    userAgents: { Firefox: 2 },
  });
});
