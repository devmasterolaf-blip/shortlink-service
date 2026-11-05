import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import { createHttpServer } from '../src/http/server.js';

/**
 * One request on a fresh connection (no keep-alive pooling).
 * @param {number} port
 * @param {string} [path]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function get(port, path = '/') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('listens on an ephemeral port and serves requests', async () => {
  const managed = createHttpServer((req, res) => res.end('hello'));
  const { port, host } = await managed.listen(0);
  try {
    assert.ok(port > 0);
    assert.equal(host, '127.0.0.1');
    assert.equal((await get(port)).body, 'hello');
  } finally {
    await managed.close();
  }
  await assert.rejects(get(port), /ECONNREFUSED/);
});

test('close waits for an in-flight request', async () => {
  /** @type {() => void} */
  let release = () => {};
  /** @type {() => void} */
  let started = () => {};
  const handlerEntered = new Promise((resolve) => (started = () => resolve(undefined)));
  const managed = createHttpServer(async (req, res) => {
    started();
    await new Promise((resolve) => (release = () => resolve(undefined)));
    res.end('finished');
  });
  const { port } = await managed.listen(0);
  const pending = get(port);
  await handlerEntered;

  let closed = false;
  const closing = managed.close().then(() => (closed = true));
  assert.equal(managed.isClosing(), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closed, false, 'server closed while a request was still running');

  release();
  const response = await pending;
  assert.equal(response.body, 'finished');
  await closing;
  assert.equal(closed, true);
});

test('a keep-alive connection that is busy at shutdown is closed right after its response', async () => {
  /** @type {Array<() => void>} */
  const releases = [];
  const managed = createHttpServer(async (req, res) => {
    if (req.url === '/slow') await new Promise((resolve) => releases.push(() => resolve(undefined)));
    res.end('ok');
  });
  const { port } = await managed.listen(0);

  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const slow = new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/slow', agent }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.headers.connection));
    });
    req.on('error', reject);
    req.end();
  });
  while (releases.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const startedAt = Date.now();
  const closing = managed.close();
  releases[0]();
  assert.equal(await slow, 'close');
  await closing;
  // Well below the 5 s keep-alive timeout the connection would otherwise sit out.
  assert.ok(Date.now() - startedAt < 2000, `shutdown took ${Date.now() - startedAt} ms`);
  agent.destroy();
});

test('force-closes connections that outlive the grace period', async () => {
  const managed = createHttpServer(() => {
    // Never responds.
  }, { shutdownGraceMs: 50 });
  const { port } = await managed.listen(0);
  const hanging = get(port).then(
    () => 'responded',
    (err) => err.code,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const startedAt = Date.now();
  await managed.close();
  assert.ok(Date.now() - startedAt < 2000);
  assert.equal(await hanging, 'ECONNRESET');
});

test('close is idempotent and safe before listen', async () => {
  const never = createHttpServer((req, res) => res.end());
  await never.close();
  const managed = createHttpServer((req, res) => res.end());
  await managed.listen(0);
  const first = managed.close();
  assert.equal(managed.close(), first);
  await first;
});

test('a handler that throws still gets a response', async () => {
  const managed = createHttpServer(async () => {
    throw new Error('unexpected');
  });
  const { port } = await managed.listen(0);
  try {
    assert.equal((await get(port)).status, 500);
  } finally {
    await managed.close();
  }
});

test('listen rejects when the port is already taken', async () => {
  const first = createHttpServer((req, res) => res.end());
  const { port } = await first.listen(0);
  const second = createHttpServer((req, res) => res.end());
  try {
    await assert.rejects(second.listen(port), /EADDRINUSE/);
  } finally {
    await first.close();
    await second.close();
  }
});
