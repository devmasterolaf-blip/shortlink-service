import test from 'node:test';
import assert from 'node:assert/strict';
import { Router, compose } from '../src/http/router.js';
import { MethodNotAllowedError, NotFoundError, ValidationError } from '../src/errors.js';

const noop = () => {};

function sampleRouter() {
  return new Router()
    .get('/healthz', noop)
    .get('/api/links', noop)
    .post('/api/links', noop)
    .get('/api/links/:code', noop)
    .delete('/api/links/:code', noop)
    .get('/api/links/:code/stats', noop)
    .get('/:code', noop)
    .post('/:code', noop);
}

test('matches static and parameterised routes', () => {
  const router = sampleRouter();
  assert.equal(router.match('GET', '/api/links').route.pattern, '/api/links');
  const single = router.match('GET', '/api/links/abc123');
  assert.equal(single.route.pattern, '/api/links/:code');
  assert.deepEqual(single.params, { code: 'abc123' });
  assert.equal(router.match('GET', '/api/links/abc123/stats').route.pattern, '/api/links/:code/stats');
  assert.deepEqual(router.match('get', '/xyz').params, { code: 'xyz' });
});

test('static routes win over parameterised ones', () => {
  const router = sampleRouter();
  assert.equal(router.match('GET', '/healthz').route.pattern, '/healthz');
  // POST /healthz must not fall through to POST /:code.
  assert.throws(() => router.match('POST', '/healthz'), MethodNotAllowedError);
});

test('distinguishes 404 from 405 and lists allowed methods', () => {
  const router = sampleRouter();
  assert.throws(() => router.match('GET', '/api/unknown/deep/path'), NotFoundError);
  assert.throws(() => router.match('GET', '/'), NotFoundError);
  assert.throws(() => router.match('PUT', '/api/links/abc'), (err) => {
    assert.ok(err instanceof MethodNotAllowedError);
    assert.deepEqual(err.allowed, ['DELETE', 'GET', 'HEAD']);
    return true;
  });
});

test('HEAD falls back to the GET route', () => {
  const router = sampleRouter();
  assert.equal(router.match('HEAD', '/abc').route.method, 'GET');
  const withHead = new Router().get('/x', noop).add('HEAD', '/x', noop);
  assert.equal(withHead.match('HEAD', '/x').route.method, 'HEAD');
});

test('tolerates one trailing slash but not empty segments', () => {
  const router = sampleRouter();
  assert.equal(router.match('GET', '/api/links/').route.pattern, '/api/links');
  assert.throws(() => router.match('GET', '/api//stats'), NotFoundError);
  assert.throws(() => router.match('GET', '/api/links//'), NotFoundError);
});

test('decodes parameters and rejects broken percent-encoding', () => {
  const router = sampleRouter();
  assert.deepEqual(router.match('GET', '/caf%C3%A9').params, { code: 'café' });
  assert.deepEqual(router.match('GET', '/a%2Fb').params, { code: 'a/b' });
  assert.throws(() => router.match('GET', '/bad%E0%A4%A'), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.code, 'bad_path');
    return true;
  });
});

test('rejects invalid route definitions', () => {
  const router = sampleRouter();
  assert.throws(() => router.get('no-slash', noop), TypeError);
  assert.throws(() => router.get('/a/:x/:x', noop), TypeError);
  assert.throws(() => router.get('/a/:', noop), TypeError);
  assert.throws(() => router.get('/empty'), TypeError);
  assert.throws(() => router.get('/healthz', noop), TypeError);
});

test('compose runs middleware in onion order', async () => {
  /** @type {string[]} */
  const log = [];
  const run = compose([
    async (ctx, next) => { log.push('a-in'); await next(); log.push('a-out'); },
    async (ctx, next) => { log.push('b-in'); await next(); log.push('b-out'); },
    () => { log.push('handler'); },
  ]);
  await run({});
  assert.deepEqual(log, ['a-in', 'b-in', 'handler', 'b-out', 'a-out']);
});

test('compose stops when a middleware does not call next and propagates errors', async () => {
  /** @type {string[]} */
  const log = [];
  await compose([() => { log.push('guard'); }, () => { log.push('never'); }])({});
  assert.deepEqual(log, ['guard']);
  await assert.rejects(compose([async (ctx, next) => { await next(); }, () => { throw new Error('boom'); }])({}), /boom/);
  await assert.rejects(compose([async (ctx, next) => { await next(); await next(); }])({}), /more than once/);
});
