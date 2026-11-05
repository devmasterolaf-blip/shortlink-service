import test from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, startApp } from './httpHelpers.js';

test('health endpoint needs no key', async (t) => {
  const { api, clock } = await startApp(t);
  clock.advance(42_500);
  const res = await api('GET', '/healthz', { key: null });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: 'ok', links: 0, uptimeSeconds: 42 });
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('create, read, update and delete a link over HTTP', async (t) => {
  const { api } = await startApp(t);
  const created = await api('POST', '/api/links', { body: { url: 'https://example.com/a', alias: 'first', tags: ['x'] } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('location'), '/api/links/first');
  assert.equal(created.json.shortUrl, 'https://sho.rt/first');

  const fetched = await api('GET', '/api/links/first');
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.json, created.json);

  const patched = await api('PATCH', '/api/links/first', { body: { enabled: false, maxClicks: 9 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.status, 'disabled');
  assert.equal(patched.json.maxClicks, 9);

  const removed = await api('DELETE', '/api/links/first');
  assert.equal(removed.status, 204);
  assert.equal(removed.text, '');
  assert.equal((await api('GET', '/api/links/first')).status, 404);
  assert.equal((await api('DELETE', '/api/links/first')).json.error.code, 'link_not_found');
});

test('listing supports pagination, filters and sorting through the query string', async (t) => {
  const { api, clock } = await startApp(t);
  for (const alias of ['one', 'two', 'three']) {
    await api('POST', '/api/links', { body: { url: `https://example.com/${alias}`, alias, tags: alias === 'two' ? ['b'] : ['a'] } });
    clock.advance(1000);
  }
  const page = await api('GET', '/api/links?pageSize=2&sort=code');
  assert.equal(page.status, 200);
  assert.deepEqual(page.json.items.map((/** @type {any} */ link) => link.code), ['one', 'three']);
  assert.deepEqual([page.json.total, page.json.totalPages, page.json.page], [3, 2, 1]);
  const tagged = await api('GET', '/api/links?tag=a&sort=-createdAt');
  assert.deepEqual(tagged.json.items.map((/** @type {any} */ link) => link.code), ['three', 'one']);
  assert.equal((await api('GET', '/api/links?sort=code&sort=clicks')).json.error.code, 'duplicate_parameter');
  assert.equal((await api('GET', '/api/links?pageSize=0')).status, 400);
});

test('errors use one JSON envelope with the request id', async (t) => {
  const { api } = await startApp(t);
  const res = await api('POST', '/api/links', { body: { url: 'ftp://example.com/' }, headers: { 'X-Request-Id': 'trace-7' } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, {
    error: {
      code: 'url_scheme_not_allowed',
      message: 'url scheme "ftp" is not allowed (allowed: http, https)',
      details: { field: 'url' },
      requestId: 'trace-7',
    },
  });
  assert.equal(res.headers.get('x-request-id'), 'trace-7');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const generated = await api('GET', '/api/links/nope');
  assert.equal(generated.json.error.requestId, generated.headers.get('x-request-id'));
});

test('unknown routes and wrong methods', async (t) => {
  const { api } = await startApp(t);
  const missing = await api('GET', '/api/nothing/here/at/all');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'route_not_found');
  const wrong = await api('PUT', '/api/links/abc');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'DELETE, GET, HEAD, PATCH');
  assert.deepEqual(wrong.json.error.details, { allowed: ['DELETE', 'GET', 'HEAD', 'PATCH'] });
});

test('API keys are required, validated and scope-checked', async (t) => {
  const { api } = await startApp(t);
  const none = await api('GET', '/api/links', { key: null });
  assert.equal(none.status, 401);
  assert.equal(none.json.error.code, 'api_key_required');
  assert.match(String(none.headers.get('www-authenticate')), /^Bearer/);

  const bad = await api('GET', '/api/links', { key: 'not-a-real-key-000000' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'api_key_invalid');

  const viaHeader = await api('GET', '/api/links', { key: null, headers: { 'X-API-Key': KEYS.reader } });
  assert.equal(viaHeader.status, 200);

  const forbidden = await api('POST', '/api/links', { key: KEYS.reader, body: { url: 'https://example.com/' } });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(forbidden.json.error.details, { required: 'links:write' });

  await api('POST', '/api/links', { key: KEYS.writer, body: { url: 'https://example.com/', alias: 'mine' } });
  assert.equal((await api('GET', '/api/links/mine/stats', { key: KEYS.writer })).status, 403);
  assert.equal((await api('GET', '/api/links/mine/stats', { key: KEYS.stats })).status, 200);
  assert.equal((await api('GET', '/api/links/mine', { key: KEYS.stats })).status, 403);
});

test('rate limiting is per key and reports Retry-After', async (t) => {
  const { api, clock } = await startApp(t, { rate: { capacity: 2, refillPerSecond: 0.5 } });
  const first = await api('GET', '/api/links', { key: KEYS.reader });
  assert.equal(first.headers.get('x-ratelimit-limit'), '2');
  assert.equal(first.headers.get('x-ratelimit-remaining'), '1');
  await api('GET', '/api/links', { key: KEYS.reader });
  const limited = await api('GET', '/api/links', { key: KEYS.reader });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '2');
  assert.equal(limited.json.error.code, 'rate_limited');
  assert.deepEqual(limited.json.error.details, { retryAfterSeconds: 2 });

  // Another key is unaffected, and the first recovers as the clock advances.
  assert.equal((await api('GET', '/api/links', { key: KEYS.writer })).status, 200);
  clock.advance(2000);
  assert.equal((await api('GET', '/api/links', { key: KEYS.reader })).status, 200);
});

test('requests with invalid keys do not consume the rate-limit budget of a real key', async (t) => {
  const { api } = await startApp(t, { rate: { capacity: 1, refillPerSecond: 0.001 } });
  for (let i = 0; i < 3; i++) await api('GET', '/api/links', { key: 'wrong-key-0000000000' });
  assert.equal((await api('GET', '/api/links', { key: KEYS.reader })).status, 200);
});

test('request bodies are validated for type, syntax and size', async (t) => {
  const { api } = await startApp(t, { app: { maxBodyBytes: 200 } });
  const wrongType = await api('POST', '/api/links', { raw: 'url=https://example.com', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(wrongType.status, 415);
  const broken = await api('POST', '/api/links', { raw: '{"url": ', headers: { 'Content-Type': 'application/json' } });
  assert.equal(broken.status, 400);
  assert.equal(broken.json.error.code, 'invalid_json');
  const notObject = await api('POST', '/api/links', { body: ['https://example.com/'] });
  assert.equal(notObject.status, 400);
  const tooBig = await api('POST', '/api/links', { body: { url: `https://example.com/${'a'.repeat(300)}` } });
  assert.equal(tooBig.status, 413);
  assert.deepEqual(tooBig.json.error.details, { limitBytes: 200 });
  assert.equal((await api('GET', '/healthz')).json.links, 0);
});

test('stats endpoint returns the click report', async (t) => {
  const { api, service } = await startApp(t);
  await api('POST', '/api/links', { body: { url: 'https://example.com/', alias: 'tracked' } });
  await service.resolve('tracked', { ip: '203.0.113.1', referrer: 'https://blog.example/post' });
  const res = await api('GET', '/api/links/tracked/stats?from=2026-06-01&to=2026-06-01');
  assert.equal(res.status, 200);
  assert.equal(res.json.totalClicks, 1);
  assert.deepEqual(res.json.days, [{ date: '2026-06-01', clicks: 1, uniqueVisitors: 1 }]);
  assert.deepEqual(res.json.referrers, [{ referrer: 'blog.example', clicks: 1 }]);
  assert.equal((await api('GET', '/api/links/tracked/stats?from=June')).status, 400);
  assert.equal((await api('GET', '/api/links/absent/stats')).status, 404);
});

test('unexpected failures become an opaque 500 and are logged', async (t) => {
  /** @type {Array<[string, any]>} */
  const errors = [];
  const logger = { info() {}, error: (/** @type {string} */ message, /** @type {any} */ fields) => errors.push([message, fields]) };
  const { api, service } = await startApp(t, { app: { logger } });
  service.listLinks = () => {
    throw new Error('database password is hunter2');
  };
  const res = await api('GET', '/api/links');
  assert.equal(res.status, 500);
  assert.equal(res.json.error.code, 'internal_error');
  assert.ok(!res.text.includes('hunter2'));
  assert.equal(errors.length, 1);
  assert.match(errors[0][1].error, /hunter2/);
});

test('one access-log line per request with status and key name', async (t) => {
  /** @type {any[]} */
  const lines = [];
  const logger = { info: (/** @type {string} */ message, /** @type {any} */ fields) => lines.push(fields), error() {} };
  const { api } = await startApp(t, { app: { logger } });
  await api('GET', '/api/links', { key: KEYS.reader });
  await api('GET', '/api/links/nope', { key: KEYS.reader });
  assert.deepEqual(
    lines.map((line) => [line.method, line.path, line.status, line.apiKey]),
    [['GET', '/api/links', 200, 'reader'], ['GET', '/api/links/nope', 404, 'reader']],
  );
});
