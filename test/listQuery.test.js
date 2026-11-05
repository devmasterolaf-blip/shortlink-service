import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, T0, expectError, makeService } from './helpers.js';
import { parseListQuery } from '../src/service/listQuery.js';

/**
 * Five links created one minute apart with different options.
 */
async function seed() {
  const ctx = makeService();
  const { service, clock, store } = ctx;
  const specs = [
    { url: 'https://example.com/alpha', alias: 'alpha', tags: ['news', 'q1'] },
    { url: 'https://example.com/bravo', alias: 'bravo', tags: ['news'], expiresAt: T0 + DAY },
    { url: 'https://shop.example/charlie', alias: 'charlie', enabled: false },
    { url: 'https://shop.example/delta', alias: 'delta', tags: ['q1'], maxClicks: 2, expiresAt: T0 + 3 * DAY },
    { url: 'https://example.com/ECHO', alias: 'echo' },
  ];
  for (const spec of specs) {
    await service.createLink(spec);
    clock.advance(60_000);
  }
  const hit = (/** @type {string} */ code, /** @type {number} */ times) => {
    for (let i = 0; i < times; i++) {
      store.recordClick({ code, at: clock.now() + i, referrer: '(direct)', userAgent: 'Other', visitor: 'v' });
    }
  };
  hit('alpha', 3);
  hit('delta', 2);
  hit('echo', 1);
  return ctx;
}

/** @param {{ items: Array<{ code: string }> }} page */
const codes = (page) => page.items.map((link) => link.code);

test('default listing is newest first with pagination metadata', async () => {
  const { service } = await seed();
  const page = service.listLinks();
  assert.deepEqual(codes(page), ['echo', 'delta', 'charlie', 'bravo', 'alpha']);
  assert.deepEqual(
    { page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages },
    { page: 1, pageSize: 20, total: 5, totalPages: 1 },
  );
  assert.ok(!('passwordHash' in page.items[0]));
});

test('pages slice the sorted result and may be empty past the end', async () => {
  const { service } = await seed();
  assert.deepEqual(codes(service.listLinks({ pageSize: '2', sort: 'code' })), ['alpha', 'bravo']);
  assert.deepEqual(codes(service.listLinks({ pageSize: '2', sort: 'code', page: '3' })), ['echo']);
  const beyond = service.listLinks({ pageSize: '2', page: '9' });
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.total, 5);
  assert.equal(beyond.totalPages, 3);
});

test('sorts by clicks in both directions with a stable tie-break on code', async () => {
  const { service } = await seed();
  assert.deepEqual(codes(service.listLinks({ sort: '-clicks' })), ['alpha', 'delta', 'echo', 'bravo', 'charlie']);
  assert.deepEqual(codes(service.listLinks({ sort: 'clicks' })), ['bravo', 'charlie', 'echo', 'delta', 'alpha']);
});

test('links without a value sort last in both directions', async () => {
  const { service } = await seed();
  assert.deepEqual(codes(service.listLinks({ sort: 'expiresAt' })), ['bravo', 'delta', 'alpha', 'charlie', 'echo']);
  assert.deepEqual(codes(service.listLinks({ sort: '-expiresAt' })), ['delta', 'bravo', 'alpha', 'charlie', 'echo']);
});

test('filters by tag (all listed tags must match), enabled flag and text', async () => {
  const { service } = await seed();
  assert.deepEqual(codes(service.listLinks({ tag: 'news', sort: 'code' })), ['alpha', 'bravo']);
  assert.deepEqual(codes(service.listLinks({ tag: 'News, Q1' })), ['alpha']);
  assert.deepEqual(codes(service.listLinks({ enabled: 'false' })), ['charlie']);
  assert.deepEqual(codes(service.listLinks({ q: 'SHOP.example', sort: 'code' })), ['charlie', 'delta']);
  assert.deepEqual(codes(service.listLinks({ q: 'echo' })), ['echo']);
  assert.deepEqual(codes(service.listLinks({ q: 'nothing-matches' })), []);
});

test('filters by computed status', async () => {
  const { service, clock } = await seed();
  assert.deepEqual(codes(service.listLinks({ status: 'exhausted' })), ['delta']);
  assert.deepEqual(codes(service.listLinks({ status: 'disabled' })), ['charlie']);
  assert.deepEqual(codes(service.listLinks({ status: 'expired' })), []);
  clock.advance(DAY);
  assert.deepEqual(codes(service.listLinks({ status: 'expired' })), ['bravo']);
  assert.deepEqual(codes(service.listLinks({ status: 'active', sort: 'code' })), ['alpha', 'echo']);
});

test('filters by creation time window', async () => {
  const { service } = await seed();
  const after = new Date(T0 + 120_000).toISOString();
  assert.deepEqual(codes(service.listLinks({ createdAfter: after, sort: 'code' })), ['charlie', 'delta', 'echo']);
  assert.deepEqual(codes(service.listLinks({ createdBefore: String(T0 + 120_000), sort: 'code' })), ['alpha', 'bravo']);
});

test('rejects invalid query parameters', async () => {
  const { service } = await seed();
  /** @type {Array<[Record<string, string>, string]>} */
  const cases = [
    [{ page: '0' }, 'validation_error'],
    [{ page: '1.5' }, 'validation_error'],
    [{ pageSize: '101' }, 'validation_error'],
    [{ pageSize: 'ten' }, 'validation_error'],
    [{ sort: 'url' }, 'validation_error'],
    [{ enabled: 'yes' }, 'validation_error'],
    [{ status: 'archived' }, 'validation_error'],
    [{ createdAfter: 'yesterday' }, 'validation_error'],
    [{ limit: '5' }, 'unknown_field'],
  ];
  for (const [query, code] of cases) {
    await expectError(() => service.listLinks(query), code, 400);
  }
});

test('parseListQuery fills in defaults', () => {
  assert.deepEqual(parseListQuery({}), {
    page: 1,
    pageSize: 20,
    sort: { field: 'createdAt', descending: true },
    tags: [],
  });
});
