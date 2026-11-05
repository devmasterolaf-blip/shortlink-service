import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, T0, expectError, makeService } from './helpers.js';
import { VisitorHasher } from '../src/analytics/visitors.js';
import { cacheControlFor } from '../src/service/linkService.js';

const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';

test('resolve returns the destination and counts the click', async () => {
  const { service } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/page' });
  const result = await service.resolve(code, { ip: '203.0.113.5', userAgent: CHROME });
  assert.deepEqual(result, { code, url: 'https://example.com/page', status: 302, cacheControl: 'no-store' });
  const link = service.getLink(code);
  assert.equal(link.clicks, 1);
  assert.equal(link.lastClickAt, '2026-06-01T12:00:00.000Z');
});

test('unknown and disabled links are both reported as not found', async () => {
  const { service } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/', enabled: false });
  await expectError(() => service.resolve('nope'), 'link_not_found', 404);
  await expectError(() => service.resolve(code), 'link_not_found', 404);
  await service.updateLink(code, { enabled: true });
  assert.equal((await service.resolve(code)).url, 'https://example.com/');
});

test('expired links answer 410 from the exact expiry instant', async () => {
  const { service, clock } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/', ttlSeconds: 60 });
  clock.advance(59_999);
  await service.resolve(code);
  clock.advance(1);
  await expectError(() => service.resolve(code), 'link_expired', 410);
  assert.equal(service.getLink(code).clicks, 1);
});

test('click budget allows exactly maxClicks redirects', async () => {
  const { service } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/', maxClicks: 2 });
  await service.resolve(code);
  await service.resolve(code);
  await expectError(() => service.resolve(code), 'link_exhausted', 410);
  assert.equal(service.getLink(code).clicks, 2);
  assert.equal(service.getLink(code).status, 'exhausted');
  await service.updateLink(code, { maxClicks: 3 });
  await service.resolve(code);
  await expectError(() => service.resolve(code), 'link_exhausted', 410);
});

test('countClick: false resolves without consuming the budget', async () => {
  const { service } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/', maxClicks: 1 });
  await service.resolve(code, { countClick: false });
  await service.resolve(code, { countClick: false });
  assert.equal(service.getLink(code).clicks, 0);
  await service.resolve(code);
  await expectError(() => service.resolve(code, { countClick: false }), 'link_exhausted', 410);
});

test('password-protected links need the right password', async () => {
  const { service } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/secret', password: 'let me in' });
  await expectError(() => service.resolve(code), 'password_required', 401);
  await expectError(() => service.resolve(code, { password: '' }), 'password_required', 401);
  await expectError(() => service.resolve(code, { password: 'wrong' }), 'password_incorrect', 403);
  assert.equal(service.getLink(code).clicks, 0);
  assert.equal((await service.resolve(code, { password: 'let me in' })).url, 'https://example.com/secret');
  assert.equal(service.getLink(code).clicks, 1);
});

test('expiry is reported before the password is asked for', async () => {
  const { service, clock } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/', password: 'let me in', ttlSeconds: 10 });
  clock.advance(10_000);
  await expectError(() => service.resolve(code), 'link_expired', 410);
});

test('concurrent visitors cannot overshoot the budget of a protected link', async () => {
  const { service } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/', password: 'let me in', maxClicks: 1 });
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => service.resolve(code, { password: 'let me in' })),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(service.getLink(code).clicks, 1);
});

test('cache policy depends on redirect type and link options', async () => {
  const base = {
    code: 'c', url: 'https://example.com/', custom: false, createdAt: T0, updatedAt: T0, expiresAt: null,
    maxClicks: null, clicks: 0, lastClickAt: null, passwordHash: null, enabled: true, tags: [],
  };
  /** @param {object} over */
  const policy = (over) => cacheControlFor(/** @type {any} */ ({ ...base, ...over }), T0, 3600);
  assert.equal(policy({ redirectType: 302 }), 'no-store');
  assert.equal(policy({ redirectType: 307 }), 'no-store');
  assert.equal(policy({ redirectType: 301 }), 'public, max-age=3600');
  assert.equal(policy({ redirectType: 301, expiresAt: T0 + 90_500 }), 'private, max-age=90');
  assert.equal(policy({ redirectType: 301, expiresAt: T0 + DAY }), 'private, max-age=3600');
  assert.equal(policy({ redirectType: 301, maxClicks: 10 }), 'no-store');
  assert.equal(policy({ redirectType: 301, passwordHash: 'scrypt$...' }), 'no-store');
});

test('resolve uses the per-link redirect type', async () => {
  const { service } = makeService({ permanentMaxAge: 600 });
  const permanent = await service.createLink({ url: 'https://example.com/a', redirectType: 301 });
  const preserving = await service.createLink({ url: 'https://example.com/b', redirectType: 307 });
  assert.deepEqual(
    [(await service.resolve(permanent.code)).status, (await service.resolve(permanent.code)).cacheControl],
    [301, 'public, max-age=600'],
  );
  assert.equal((await service.resolve(preserving.code)).status, 307);
});

test('stats report aggregates days, referrers, agents and unique visitors', async () => {
  const { service, clock } = makeService({ visitorHasher: new VisitorHasher({ secret: 'fixed' }) });
  const { code } = await service.createLink({ url: 'https://example.com/' });
  await service.resolve(code, { ip: '203.0.113.1', userAgent: CHROME, referrer: 'https://news.example/post/1' });
  await service.resolve(code, { ip: '203.0.113.1', userAgent: CHROME, referrer: 'https://news.example/post/2' });
  await service.resolve(code, { ip: '203.0.113.2', userAgent: FIREFOX });
  clock.advance(DAY);
  await service.resolve(code, { ip: '203.0.113.1', userAgent: CHROME });

  assert.deepEqual(service.getStats(code), {
    code,
    totalClicks: 4,
    clicksInRange: 4,
    uniqueVisitors: 3,
    lastClickAt: '2026-06-02T12:00:00.000Z',
    days: [
      { date: '2026-06-01', clicks: 3, uniqueVisitors: 2 },
      { date: '2026-06-02', clicks: 1, uniqueVisitors: 1 },
    ],
    referrers: [
      { referrer: '(direct)', clicks: 2 },
      { referrer: 'news.example', clicks: 2 },
    ],
    userAgents: [
      { family: 'Chrome', clicks: 3 },
      { family: 'Firefox', clicks: 1 },
    ],
  });
});

test('stats report honours an inclusive date range', async () => {
  const { service, clock } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/' });
  for (let day = 0; day < 4; day++) {
    await service.resolve(code, { ip: '203.0.113.1' });
    clock.advance(DAY);
  }
  const report = service.getStats(code, { from: '2026-06-02', to: '2026-06-03' });
  assert.deepEqual(report.days.map((day) => day.date), ['2026-06-02', '2026-06-03']);
  assert.equal(report.clicksInRange, 2);
  assert.equal(report.totalClicks, 4);
  assert.deepEqual(service.getStats(code, { from: '2026-06-04' }).days.map((day) => day.date), ['2026-06-04']);
  assert.deepEqual(service.getStats(code, { to: '2026-05-31' }).days, []);
});

test('stats report validates its range and the link', async () => {
  const { service } = makeService();
  const { code } = await service.createLink({ url: 'https://example.com/' });
  await expectError(() => service.getStats(code, { from: '2026-02-30' }), 'validation_error', 400);
  await expectError(() => service.getStats(code, { from: '06/01/2026' }), 'validation_error', 400);
  await expectError(() => service.getStats(code, { from: '2026-06-02', to: '2026-06-01' }), 'validation_error', 400);
  await expectError(() => service.getStats(code, { days: '7' }), 'unknown_field', 400);
  await expectError(() => service.getStats('missing'), 'link_not_found', 404);
  assert.deepEqual(service.getStats(code).days, []);
});
