import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY } from './helpers.js';
import { startApp } from './httpHelpers.js';

/**
 * @param {Awaited<ReturnType<typeof startApp>>['api']} api
 * @param {Record<string, unknown>} body
 */
async function create(api, body) {
  const res = await api('POST', '/api/links', { body });
  assert.equal(res.status, 201, res.text);
  return res.json;
}

test('temporary redirect by default, without a key and uncached', async (t) => {
  const { api, store } = await startApp(t);
  await create(api, { url: 'https://example.com/landing?x=1#top', alias: 'goto' });
  const res = await api('GET', '/goto', { key: null });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://example.com/landing?x=1#top');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.text, 'Redirecting to https://example.com/landing?x=1#top\n');
  assert.equal(store.getLink('goto')?.clicks, 1);
});

test('redirect type follows the link: 301 is cacheable, 307 is not', async (t) => {
  const { api, clock } = await startApp(t);
  await create(api, { url: 'https://example.com/p', alias: 'perm', redirectType: 301 });
  await create(api, { url: 'https://example.com/t', alias: 'temp', redirectType: 307 });
  await create(api, { url: 'https://example.com/e', alias: 'ends', redirectType: 301, expiresAt: clock.now() + 600_000 });

  const permanent = await api('GET', '/perm', { key: null });
  assert.equal(permanent.status, 301);
  assert.equal(permanent.headers.get('cache-control'), 'public, max-age=86400');
  const temporary = await api('GET', '/temp', { key: null });
  assert.equal(temporary.status, 307);
  assert.equal(temporary.headers.get('cache-control'), 'no-store');
  // A permanent redirect that expires must not be cached past its expiry.
  const expiring = await api('GET', '/ends', { key: null });
  assert.equal(expiring.status, 301);
  assert.equal(expiring.headers.get('cache-control'), 'private, max-age=600');
});

test('unknown and disabled codes are 404, expired and used-up ones are 410', async (t) => {
  const { api, clock } = await startApp(t);
  await create(api, { url: 'https://example.com/', alias: 'off', enabled: false });
  await create(api, { url: 'https://example.com/', alias: 'brief', expiresAt: clock.now() + DAY });
  await create(api, { url: 'https://example.com/', alias: 'once', maxClicks: 1 });

  const unknown = await api('GET', '/nothing', { key: null });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'link_not_found');
  assert.equal(unknown.headers.get('location'), null);
  assert.equal((await api('GET', '/off', { key: null })).status, 404);

  assert.equal((await api('GET', '/brief', { key: null })).status, 302);
  clock.advance(DAY);
  const expired = await api('GET', '/brief', { key: null });
  assert.equal(expired.status, 410);
  assert.equal(expired.json.error.code, 'link_expired');
  assert.equal(expired.headers.get('cache-control'), 'no-store');

  assert.equal((await api('GET', '/once', { key: null })).status, 302);
  const exhausted = await api('GET', '/once', { key: null });
  assert.equal(exhausted.status, 410);
  assert.equal(exhausted.json.error.code, 'link_exhausted');
});

test('HEAD answers like GET but is not counted as a click', async (t) => {
  const { api, store } = await startApp(t);
  await create(api, { url: 'https://example.com/', alias: 'peek', maxClicks: 1 });
  const head = await api('HEAD', '/peek', { key: null });
  assert.equal(head.status, 302);
  assert.equal(head.headers.get('location'), 'https://example.com/');
  assert.equal(head.text, '');
  assert.equal(store.getLink('peek')?.clicks, 0);
  assert.equal((await api('GET', '/peek', { key: null })).status, 302);
  assert.equal((await api('HEAD', '/peek', { key: null })).status, 410);
});

test('password-protected links: header on GET', async (t) => {
  const { api, store } = await startApp(t);
  await create(api, { url: 'https://example.com/secret', alias: 'vault', password: 'open sesame' });
  const missing = await api('GET', '/vault', { key: null });
  assert.equal(missing.status, 401);
  assert.equal(missing.json.error.code, 'password_required');
  assert.equal(missing.headers.get('www-authenticate'), null);
  const wrong = await api('GET', '/vault', { key: null, headers: { 'X-Link-Password': 'guess' } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.error.code, 'password_incorrect');
  assert.equal(store.getLink('vault')?.clicks, 0);
  const right = await api('GET', '/vault', { key: null, headers: { 'X-Link-Password': 'open sesame' } });
  assert.equal(right.status, 302);
  assert.equal(right.headers.get('cache-control'), 'no-store');
  assert.equal(store.getLink('vault')?.clicks, 1);
});

test('password-protected links: unlock with POST always answers 303', async (t) => {
  const { api } = await startApp(t);
  await create(api, { url: 'https://example.com/secret', alias: 'vault', password: 'open sesame', redirectType: 307 });
  const json = await api('POST', '/vault', { key: null, body: { password: 'open sesame' } });
  assert.equal(json.status, 303);
  assert.equal(json.headers.get('location'), 'https://example.com/secret');
  assert.equal(json.headers.get('cache-control'), 'no-store');

  const form = await api('POST', '/vault', {
    key: null,
    raw: 'password=open+sesame',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(form.status, 303);

  assert.equal((await api('POST', '/vault', { key: null, body: { password: 'nope' } })).status, 403);
  assert.equal((await api('POST', '/vault', { key: null, body: {} })).status, 401);
  assert.equal((await api('POST', '/vault', { key: null, body: { password: 42 } })).status, 401);
  const text = await api('POST', '/vault', { key: null, raw: 'open sesame', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(text.status, 415);
  const huge = await api('POST', '/vault', { key: null, body: { password: 'x'.repeat(2000) } });
  assert.equal(huge.status, 413);
});

test('clicks record referrer, user agent and the visitor behind a trusted proxy', async (t) => {
  const { api } = await startApp(t, { app: { trustProxy: true } });
  await create(api, { url: 'https://example.com/', alias: 'seen' });
  const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  for (const ip of ['198.51.100.1', '198.51.100.1', '198.51.100.2']) {
    await api('GET', '/seen', {
      key: null,
      headers: { 'X-Forwarded-For': ip, Referer: 'https://www.news.example/story', 'User-Agent': chrome },
    });
  }
  const stats = (await api('GET', '/api/links/seen/stats')).json;
  assert.equal(stats.totalClicks, 3);
  assert.equal(stats.uniqueVisitors, 2);
  assert.deepEqual(stats.referrers, [{ referrer: 'news.example', clicks: 3 }]);
  assert.deepEqual(stats.userAgents, [{ family: 'Chrome', clicks: 3 }]);
});

test('reserved words never shadow service routes', async (t) => {
  const { api } = await startApp(t);
  const res = await api('POST', '/api/links', { body: { url: 'https://example.com/', alias: 'healthz' } });
  assert.equal(res.json.error.code, 'alias_reserved');
  assert.equal((await api('GET', '/healthz', { key: null })).json.status, 'ok');
  assert.equal((await api('DELETE', '/goto', { key: null })).status, 405);
});
