import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, T0, expectError, makeService } from './helpers.js';
import { CodePermutation } from '../src/codes/base62.js';
import { verifyPassword } from '../src/security/password.js';

test('createLink applies defaults and returns the public view', async () => {
  const { service, store } = makeService();
  const link = await service.createLink({ url: 'HTTPS://Example.com/Landing?x=1' });
  assert.equal(link.code, new CodePermutation({ minLength: 4 }).encode(0));
  assert.deepEqual(link, {
    code: link.code,
    shortUrl: `https://sho.rt/${link.code}`,
    url: 'https://example.com/Landing?x=1',
    custom: false,
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z',
    expiresAt: null,
    maxClicks: null,
    clicks: 0,
    lastClickAt: null,
    hasPassword: false,
    enabled: true,
    tags: [],
    redirectType: 302,
    status: 'active',
  });
  assert.equal(store.countLinks(), 1);
});

test('createLink with every option', async () => {
  const { service, store } = makeService();
  const link = await service.createLink({
    url: 'https://example.com/',
    alias: 'Spring-Sale',
    ttlSeconds: 3600,
    maxClicks: 5,
    password: 'open sesame',
    enabled: false,
    tags: [' Promo ', 'q2', 'promo'],
    redirectType: 301,
  });
  assert.equal(link.code, 'Spring-Sale');
  assert.equal(link.custom, true);
  assert.equal(link.expiresAt, new Date(T0 + 3_600_000).toISOString());
  assert.equal(link.maxClicks, 5);
  assert.equal(link.hasPassword, true);
  assert.equal(link.status, 'disabled');
  assert.deepEqual(link.tags, ['promo', 'q2']);
  assert.equal(link.redirectType, 301);
  assert.ok(!('passwordHash' in link));
  const stored = store.getLink('Spring-Sale');
  assert.equal(await verifyPassword('open sesame', /** @type {string} */ (stored?.passwordHash)), true);
});

test('createLink rejects malformed input with field-level errors', async () => {
  const { service, store } = makeService();
  const url = 'https://example.com/';
  /** @type {Array<[unknown, string, string | undefined]>} */
  const cases = [
    [null, 'validation_error', undefined],
    [[], 'validation_error', undefined],
    [{}, 'url_invalid', 'url'],
    [{ url: 'javascript:alert(1)' }, 'url_scheme_not_allowed', 'url'],
    [{ url, alias: 'no' }, 'alias_length', 'alias'],
    [{ url, alias: 'api' }, 'alias_reserved', 'alias'],
    [{ url, expiresAt: '2020-01-01T00:00:00Z' }, 'validation_error', 'expiresAt'],
    [{ url, expiresAt: 'tomorrow' }, 'validation_error', 'expiresAt'],
    [{ url, expiresAt: '2027-01-01T10:00:00' }, 'validation_error', 'expiresAt'],
    [{ url, expiresAt: T0 + 1000, ttlSeconds: 5 }, 'validation_error', 'expiresAt'],
    [{ url, ttlSeconds: 0 }, 'validation_error', 'ttlSeconds'],
    [{ url, ttlSeconds: 1.5 }, 'validation_error', 'ttlSeconds'],
    [{ url, maxClicks: 0 }, 'validation_error', 'maxClicks'],
    [{ url, maxClicks: '3' }, 'validation_error', 'maxClicks'],
    [{ url, password: 'abc' }, 'validation_error', 'password'],
    [{ url, password: 1234 }, 'validation_error', 'password'],
    [{ url, enabled: 'yes' }, 'validation_error', 'enabled'],
    [{ url, tags: 'promo' }, 'validation_error', 'tags'],
    [{ url, tags: ['ok', 'not ok'] }, 'validation_error', 'tags'],
    [{ url, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, 'validation_error', 'tags'],
    [{ url, redirectType: 303 }, 'validation_error', 'redirectType'],
    [{ url, clicks: 10, colour: 'red' }, 'unknown_field', undefined],
  ];
  for (const [input, code, field] of cases) {
    const err = await expectError(() => service.createLink(input), code, 400);
    assert.equal(err.field, field, JSON.stringify(input));
  }
  assert.equal(store.countLinks(), 0);
});

test('expiresAt accepts ISO strings with a zone, date-only strings and epoch milliseconds', async () => {
  const { service } = makeService();
  const url = 'https://example.com/';
  assert.equal((await service.createLink({ url, expiresAt: '2026-06-02T00:00:00+02:00' })).expiresAt, '2026-06-01T22:00:00.000Z');
  assert.equal((await service.createLink({ url, expiresAt: '2026-06-02' })).expiresAt, '2026-06-02T00:00:00.000Z');
  assert.equal((await service.createLink({ url, expiresAt: T0 + 1 })).expiresAt, new Date(T0 + 1).toISOString());
});

test('aliases are unique and case-sensitive', async () => {
  const { service } = makeService();
  await service.createLink({ url: 'https://example.com/a', alias: 'promo' });
  await expectError(() => service.createLink({ url: 'https://example.com/b', alias: 'promo' }), 'alias_taken', 409);
  const upper = await service.createLink({ url: 'https://example.com/c', alias: 'Promo' });
  assert.equal(upper.code, 'Promo');
});

test('generated codes skip aliases that already use the same code', async () => {
  const permutation = new CodePermutation({ minLength: 4 });
  const { service } = makeService();
  await service.createLink({ url: 'https://example.com/squatter', alias: permutation.encode(0) });
  const generated = await service.createLink({ url: 'https://example.com/next' });
  assert.equal(generated.code, permutation.encode(1));
  assert.equal(generated.custom, false);
});

test('generated codes never equal a reserved word', async () => {
  const proposals = ['docs', 'API', 'ok42'];
  const { service } = makeService({ generator: { next: () => /** @type {string} */ (proposals.shift()) } });
  assert.equal((await service.createLink({ url: 'https://example.com/' })).code, 'ok42');
});

test('code allocation gives up after too many collisions', async () => {
  const attempts = [];
  const { service } = makeService({
    maxCodeAttempts: 4,
    generator: { next: (attempt) => (attempts.push(attempt), 'same') },
  });
  await service.createLink({ url: 'https://example.com/1' });
  await expectError(() => service.createLink({ url: 'https://example.com/2' }), 'code_space_exhausted', 503);
  assert.deepEqual(attempts, [0, 0, 1, 2, 3]);
});

test('links pointing at the service itself are refused', async () => {
  const { service } = makeService({ urlPolicy: { selfHosts: ['sho.rt'] } });
  await expectError(() => service.createLink({ url: 'https://sho.rt/abcd' }), 'url_self_reference', 400);
});

test('getLink and deleteLink report unknown codes', async () => {
  const { service } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/' });
  assert.equal(service.getLink(code).url, 'https://example.com/');
  service.deleteLink(code);
  await expectError(() => service.getLink(code), 'link_not_found', 404);
  await expectError(() => service.deleteLink(code), 'link_not_found', 404);
});

test('updateLink changes only the given fields and bumps updatedAt', async () => {
  const { service, clock } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/', tags: ['a'], maxClicks: 3 });
  clock.advance(5000);
  const updated = await service.updateLink(code, { url: 'https://example.org/new', enabled: false });
  assert.equal(updated.url, 'https://example.org/new');
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.tags, ['a']);
  assert.equal(updated.maxClicks, 3);
  assert.equal(updated.createdAt, '2026-06-01T12:00:00.000Z');
  assert.equal(updated.updatedAt, '2026-06-01T12:00:05.000Z');
});

test('updateLink clears optional settings with null', async () => {
  const { service, store } = makeService();
  const { code } = await service.createLink({
    url: 'https://example.com/',
    ttlSeconds: 60,
    maxClicks: 3,
    password: 'hunter22',
  });
  const cleared = await service.updateLink(code, { expiresAt: null, maxClicks: null, password: null });
  assert.equal(cleared.expiresAt, null);
  assert.equal(cleared.maxClicks, null);
  assert.equal(cleared.hasPassword, false);
  assert.equal(store.getLink(code)?.passwordHash, null);
});

test('updateLink validates its input and leaves the link untouched on error', async () => {
  const { service, clock } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/' });
  clock.advance(1000);
  await expectError(() => service.updateLink(code, { alias: 'renamed' }), 'unknown_field', 400);
  await expectError(() => service.updateLink(code, { url: 'nope' }), 'url_invalid', 400);
  await expectError(() => service.updateLink(code, { enabled: false, redirectType: 308 }), 'validation_error', 400);
  await expectError(() => service.updateLink('missing', { enabled: false }), 'link_not_found', 404);
  const link = service.getLink(code);
  assert.equal(link.enabled, true);
  assert.equal(link.updatedAt, link.createdAt);
});

test('an empty patch is a no-op that does not bump updatedAt', async () => {
  const { service, clock } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/' });
  clock.advance(1000);
  const same = await service.updateLink(code, {});
  assert.equal(same.updatedAt, same.createdAt);
});

test('status reflects expiry as the clock moves', async () => {
  const { service, clock } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/', expiresAt: T0 + DAY });
  assert.equal(service.getLink(code).status, 'active');
  clock.advance(DAY - 1);
  assert.equal(service.getLink(code).status, 'active');
  clock.advance(1);
  assert.equal(service.getLink(code).status, 'expired');
});
