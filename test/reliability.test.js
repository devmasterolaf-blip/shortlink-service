/**
 * Failure paths that the feature tests do not reach: races, broken
 * connections and write errors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { StorageError } from '../src/errors.js';
import { readBody } from '../src/http/body.js';
import { createContext } from '../src/http/context.js';
import { errorBoundary } from '../src/http/middleware.js';
import { compose } from '../src/http/router.js';
import { createHttpServer } from '../src/http/server.js';
import { FileStore } from '../src/storage/fileStore.js';
import { T0, makeService } from './helpers.js';
import { startApp } from './httpHelpers.js';
import { tempDir } from './tmp.js';

test('concurrent creations of one alias: exactly one wins, even while passwords are hashed', async () => {
  const { service, store } = makeService();
  const attempts = await Promise.allSettled(
    ['first-pass', 'second-pass', 'third-pass'].map((password) =>
      service.createLink({ url: `https://example.com/${password}`, alias: 'contested', password }),
    ),
  );
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  for (const attempt of attempts) {
    if (attempt.status === 'rejected') assert.equal(attempt.reason.code, 'alias_taken');
  }
  assert.equal(store.countLinks(), 1);
});

test('a link deleted while its new password is hashed is not resurrected', async () => {
  const { service, store } = makeService();
  await service.createLink({ url: 'https://example.com/', alias: 'fleeting' });
  const update = service.updateLink('fleeting', { password: 'new-password' });
  service.deleteLink('fleeting');
  await assert.rejects(update, (/** @type {any} */ err) => err.code === 'link_not_found');
  assert.equal(store.hasLink('fleeting'), false);
});

test('a failure after the response has started drops the connection', async (t) => {
  /** @type {string[]} */
  const logged = [];
  const logger = { info() {}, error: (/** @type {string} */ message) => logged.push(message) };
  const pipeline = compose([
    errorBoundary(logger),
    async (/** @type {import('../src/http/context.js').RequestContext} */ ctx) => {
      ctx.res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 100 });
      ctx.res.write('partial');
      throw new Error('lost the rest');
    },
  ]);
  const managed = createHttpServer((req, res) => pipeline(createContext(req, res)), { shutdownGraceMs: 200 });
  const { port } = await managed.listen(0);
  t.after(() => managed.close());

  const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { Connection: 'close' } });
  assert.equal(response.status, 200);
  // The body is shorter than promised, so the client sees an error instead of truncated data.
  await assert.rejects(response.text());
  assert.deepEqual(logged, ['request failed']);
});

test('an upload that is cut off is reported as aborted, and the server keeps serving', async (t) => {
  /** @type {Promise<unknown>} */
  let outcome = Promise.resolve();
  /** @type {() => void} */
  let seen = () => {};
  const received = new Promise((resolve) => {
    seen = () => resolve(undefined);
  });
  const managed = createHttpServer(
    (req, res) => {
      if (req.method === 'POST') {
        outcome = readBody(req, 1000).catch((err) => err);
        req.once('data', seen);
        return;
      }
      res.end('ok');
    },
    { shutdownGraceMs: 200 },
  );
  const { port } = await managed.listen(0);
  t.after(() => managed.close());

  const socket = net.connect(port, '127.0.0.1');
  socket.write('POST /upload HTTP/1.1\r\nHost: test\r\nContent-Length: 500\r\n\r\nonly the beginning');
  await received;
  socket.destroy();
  await new Promise((resolve) => socket.once('close', resolve));
  const err = /** @type {any} */ (await outcome);
  assert.ok(['request_aborted', 'ECONNRESET'].includes(err.code), String(err));

  const after = await fetch(`http://127.0.0.1:${port}/`, { headers: { Connection: 'close' } });
  assert.equal(await after.text(), 'ok');
});

test('a write that fails leaves memory and the API consistent with the file', async (t) => {
  const dataFile = path.join(tempDir(t), 'links.jsonl');
  const store = FileStore.open(dataFile, { fsync: 'never' });
  t.after(() => store.close());
  const { api } = await startApp(t, { service: { store } });
  assert.equal((await api('POST', '/api/links', { body: { url: 'https://example.com/', alias: 'saved' } })).status, 201);

  const realWrite = fs.writeSync;
  t.after(() => {
    fs.writeSync = realWrite;
  });
  fs.writeSync = () => {
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  };
  assert.throws(() => store.deleteLink('saved'), StorageError);
  const failed = await api('POST', '/api/links', { body: { url: 'https://example.com/', alias: 'lost' } });
  assert.equal(failed.status, 500);
  assert.equal(failed.json.error.code, 'internal_error');
  assert.ok(!failed.text.includes('ENOSPC'));
  // A redirect has to record its click, so it fails as well while writes fail.
  assert.equal((await api('GET', '/saved', { key: null })).status, 500);
  fs.writeSync = realWrite;

  assert.equal(store.hasLink('lost'), false);
  assert.equal(store.getLink('saved')?.clicks, 0);
  assert.equal((await api('GET', '/saved', { key: null })).status, 302);
  store.close();
  const reopened = FileStore.open(dataFile, { fsync: 'never' });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.listLinks().map((link) => [link.code, link.clicks, link.createdAt]), [['saved', 1, T0]]);
});
