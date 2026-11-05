import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { clientIp, createContext, queryToObject } from '../src/http/context.js';
import { mediaType, parseJson, readBody, readJson } from '../src/http/body.js';
import { presentedApiKey } from '../src/http/middleware.js';
import { expectError } from './helpers.js';

/**
 * Minimal stand-in for an IncomingMessage.
 * @param {{ url?: string, method?: string, headers?: Record<string, string | string[]>, chunks?: Array<string | Buffer>, remoteAddress?: string }} [options]
 * @returns {any}
 */
function fakeRequest({ url = '/', method = 'GET', headers = {}, chunks = [], remoteAddress = '198.51.100.9' } = {}) {
  const req = /** @type {any} */ (Readable.from(chunks.map((chunk) => Buffer.from(chunk)), { objectMode: false }));
  req.url = url;
  req.method = method;
  req.headers = headers;
  Object.defineProperty(req, 'socket', { value: { remoteAddress } });
  return req;
}

test('createContext splits path and query without resolving the URL', () => {
  const ctx = createContext(fakeRequest({ url: '/api/links?tag=a%20b&page=2', method: 'get' }), /** @type {any} */ ({}));
  assert.equal(ctx.method, 'GET');
  assert.equal(ctx.path, '/api/links');
  assert.equal(ctx.query.get('tag'), 'a b');
  assert.equal(ctx.ip, '198.51.100.9');
  assert.match(ctx.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(createContext(fakeRequest({ url: '//evil.example/x' }), /** @type {any} */ ({})).path, '//evil.example/x');
});

test('request ids are taken from the client only when well-formed', () => {
  const res = /** @type {any} */ ({});
  assert.equal(createContext(fakeRequest({ headers: { 'x-request-id': 'trace-42.a' } }), res).requestId, 'trace-42.a');
  assert.notEqual(createContext(fakeRequest({ headers: { 'x-request-id': 'bad id\n' } }), res).requestId, 'bad id\n');
  assert.notEqual(createContext(fakeRequest({ headers: { 'x-request-id': 'x'.repeat(65) } }), res).requestId.length, 65);
});

test('clientIp trusts X-Forwarded-For only when told to, and then the last hop', () => {
  const req = fakeRequest({ headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.2 , 192.0.2.7' } });
  assert.equal(clientIp(req, false), '198.51.100.9');
  assert.equal(clientIp(req, true), '192.0.2.7');
  assert.equal(clientIp(fakeRequest({ headers: { 'x-forwarded-for': ' , ' } }), true), '198.51.100.9');
  assert.equal(clientIp(fakeRequest(), true), '198.51.100.9');
});

test('queryToObject rejects repeated parameters', async () => {
  assert.deepEqual(queryToObject(new URLSearchParams('a=1&b=two')), { a: '1', b: 'two' });
  const err = await expectError(() => queryToObject(new URLSearchParams('page=1&page=2')), 'duplicate_parameter', 400);
  assert.deepEqual(err.details, { parameter: 'page' });
});

test('readBody concatenates chunks up to the limit', async () => {
  const body = await readBody(fakeRequest({ chunks: ['hel', 'lo'] }), 5);
  assert.equal(body.toString(), 'hello');
  assert.equal((await readBody(fakeRequest(), 5)).length, 0);
});

test('readBody rejects by declared length before reading', async () => {
  const req = fakeRequest({ headers: { 'content-length': '6' }, chunks: ['123456'] });
  const err = await expectError(() => readBody(req, 5), 'payload_too_large', 413);
  assert.equal(err.limitBytes, 5);
});

test('readBody rejects a streamed body once it crosses the limit', async () => {
  const req = fakeRequest({ chunks: ['1234', '5678', '9'] });
  await expectError(() => readBody(req, 5), 'payload_too_large', 413);
  // The limit counts bytes, not characters.
  await expectError(() => readBody(fakeRequest({ chunks: ['ééé'] }), 5), 'payload_too_large', 413);
});

test('readJson checks the media type and the syntax', async () => {
  const json = { 'content-type': 'application/json; charset=utf-8' };
  assert.deepEqual(await readJson(fakeRequest({ headers: json, chunks: ['{"a":', '1}'] }), 100), { a: 1 });
  await expectError(() => readJson(fakeRequest({ chunks: ['{}'] }), 100), 'unsupported_media_type', 415);
  await expectError(
    () => readJson(fakeRequest({ headers: { 'content-type': 'text/plain' }, chunks: ['{}'] }), 100),
    'unsupported_media_type',
    415,
  );
  await expectError(() => readJson(fakeRequest({ headers: json, chunks: ['{"a":'] }), 100), 'invalid_json', 400);
  await expectError(() => readJson(fakeRequest({ headers: json }), 100), 'invalid_json', 400);
  assert.equal(parseJson(Buffer.from('null')), null);
});

test('mediaType ignores parameters and case', () => {
  assert.equal(mediaType(fakeRequest({ headers: { 'content-type': 'Text/CSV; header=present' } })), 'text/csv');
  assert.equal(mediaType(fakeRequest()), '');
});

test('presentedApiKey reads bearer tokens and the X-API-Key header', () => {
  assert.equal(presentedApiKey(fakeRequest({ headers: { authorization: 'Bearer abc123' } })), 'abc123');
  assert.equal(presentedApiKey(fakeRequest({ headers: { authorization: 'bearer   abc123 ' } })), 'abc123');
  assert.equal(presentedApiKey(fakeRequest({ headers: { 'x-api-key': 'xyz' } })), 'xyz');
  assert.equal(presentedApiKey(fakeRequest({ headers: { authorization: 'Basic dXNlcjpwdw==', 'x-api-key': 'xyz' } })), undefined);
  assert.equal(presentedApiKey(fakeRequest()), undefined);
});
