import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { ManualClock } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createRuntime, openStore } from '../src/runtime.js';
import { installSignalHandlers, start } from '../src/serve.js';
import { FileStore } from '../src/storage/fileStore.js';
import * as api from '../src/index.js';
import { T0 } from './helpers.js';
import { tempDir } from './tmp.js';

const KEY = 'ops-key-0123456789abcdef';

/** @param {Record<string, string>} [extra] */
const configFor = (extra = {}) =>
  loadConfig({ SHORTLINK_PORT: '0', SHORTLINK_API_KEYS: `ops:${KEY}:*`, SHORTLINK_BASE_URL: 'https://sho.rt', ...extra });

/**
 * @param {number} port @param {string} method @param {string} route @param {unknown} [body]
 */
async function call(port, method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    redirect: 'manual',
    headers: { Authorization: `Bearer ${KEY}`, Connection: 'close', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, headers: response.headers, json: await response.json().catch(() => undefined) };
}

test('a configured server persists links across restarts', async (t) => {
  const dataFile = path.join(tempDir(t), 'links.jsonl');
  const config = configFor({ SHORTLINK_STORE: 'file', SHORTLINK_DATA_FILE: dataFile, SHORTLINK_FSYNC: 'never' });

  const first = await start(config);
  t.after(() => first.close());
  assert.ok(first.port > 0);
  const created = await call(first.port, 'POST', '/api/links', { url: 'https://example.com/kept' });
  assert.equal(created.status, 201);
  assert.equal(created.json.code.length, 5);
  assert.equal((await call(first.port, 'GET', `/${created.json.code}`)).status, 302);
  await first.close();
  await first.close();
  await assert.rejects(fetch(`http://127.0.0.1:${first.port}/healthz`));

  const second = await start(config);
  t.after(() => second.close());
  const fetched = await call(second.port, 'GET', `/api/links/${created.json.code}`);
  assert.equal(fetched.json.url, 'https://example.com/kept');
  assert.equal(fetched.json.clicks, 1);
  const next = await call(second.port, 'POST', '/api/links', { url: 'https://example.com/next' });
  assert.notEqual(next.json.code, created.json.code);
});

test('configuration reaches the URL policy, the redirect default and the limiter', async (t) => {
  const running = await start(
    configFor({
      SHORTLINK_BLOCK_PRIVATE_HOSTS: 'true',
      SHORTLINK_DEFAULT_REDIRECT: '307',
      SHORTLINK_RATE_LIMIT_CAPACITY: '3',
      SHORTLINK_RATE_LIMIT_REFILL_PER_SEC: '0.01',
      SHORTLINK_CODE_STRATEGY: 'random',
      SHORTLINK_CODE_LENGTH: '9',
    }),
  );
  t.after(() => running.close());
  const loopback = await call(running.port, 'POST', '/api/links', { url: 'http://127.0.0.1/admin' });
  assert.equal(loopback.json.error.code, 'url_host_not_allowed');
  const self = await call(running.port, 'POST', '/api/links', { url: 'https://sho.rt/abc' });
  assert.equal(self.json.error.code, 'url_self_reference');
  const ok = await call(running.port, 'POST', '/api/links', { url: 'https://example.com/' });
  assert.equal(ok.json.redirectType, 307);
  assert.equal(ok.json.code.length, 9);
  assert.equal(ok.json.shortUrl, `https://sho.rt/${ok.json.code}`);
  assert.equal((await call(running.port, 'GET', '/api/links')).status, 429);
});

test('a port that is already taken fails the start and releases the data file', async (t) => {
  const dataFile = path.join(tempDir(t), 'links.jsonl');
  const running = await start(configFor());
  t.after(() => running.close());
  const clash = configFor({ SHORTLINK_PORT: String(running.port), SHORTLINK_STORE: 'file', SHORTLINK_DATA_FILE: dataFile });
  await assert.rejects(start(clash), /EADDRINUSE/);
  // The store was closed again, so the file can be removed and reopened.
  fs.rmSync(dataFile);
});

test('start-up logging: address, and a warning when no API key exists', async (t) => {
  /** @type {any[]} */
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(JSON.parse(line)), clock: new ManualClock(T0) });
  const running = await start(loadConfig({ SHORTLINK_PORT: '0' }), { logger });
  t.after(() => running.close());
  assert.deepEqual(lines[0], {
    host: '127.0.0.1',
    port: running.port,
    store: 'memory',
    baseUrl: 'http://localhost:0',
    time: '2026-06-01T12:00:00.000Z',
    level: 'info',
    msg: 'listening',
  });
  assert.equal(lines[1].level, 'error');
  assert.match(lines[1].msg, /no API keys/);
  await running.close();
  assert.equal(lines.at(-1).msg, 'stopped');
});

test('logger levels and reserved keys', () => {
  /** @type {string[]} */
  const out = [];
  const write = (/** @type {string} */ line) => out.push(line);
  const quiet = createLogger({ level: 'error', write, clock: new ManualClock(T0) });
  quiet.info('ignored');
  quiet.error('kept', { level: 'spoofed', detail: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0], '{"level":"error","detail":1,"time":"2026-06-01T12:00:00.000Z","msg":"kept"}\n');
  const silent = createLogger({ level: 'silent', write });
  silent.error('nothing');
  assert.equal(out.length, 1);
});

test('the journal is compacted at start-up once it is mostly history', (t) => {
  const dataFile = path.join(tempDir(t), 'links.jsonl');
  const config = configFor({ SHORTLINK_STORE: 'file', SHORTLINK_DATA_FILE: dataFile, SHORTLINK_FSYNC: 'never' });
  const seed = FileStore.open(dataFile, { fsync: 'never' });
  seed.insertLink({
    code: 'busy', url: 'https://example.com/', custom: true, createdAt: T0, updatedAt: T0, expiresAt: null,
    maxClicks: null, clicks: 0, lastClickAt: null, passwordHash: null, enabled: true, tags: [], redirectType: 302,
  });
  for (let i = 0; i < 998; i++) seed.recordClick({ code: 'busy', at: T0 + i, referrer: '(direct)', userAgent: 'Other', visitor: 'v' });
  seed.close();

  // 999 records: below the threshold, left as it is.
  const untouched = /** @type {FileStore} */ (openStore(config));
  assert.equal(untouched.journalRecords, 999);
  untouched.recordClick({ code: 'busy', at: T0 + 999, referrer: '(direct)', userAgent: 'Other', visitor: 'v' });
  untouched.close();

  const runtime = createRuntime(config);
  t.after(() => runtime.close());
  assert.equal(/** @type {FileStore} */ (runtime.store).journalRecords, 3);
  assert.equal(runtime.service.getLink('busy').clicks, 999);
});

test('signals: the first one shuts down gracefully, a second one forces the exit', async () => {
  const proc = new EventEmitter();
  /** @type {number[]} */
  const exits = [];
  /** @type {string[]} */
  const signals = [];
  /** @type {() => void} */
  let finish = () => {};
  installSignalHandlers(
    /** @type {any} */ (proc),
    (signal) => {
      signals.push(signal);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    (code) => exits.push(code),
  );
  proc.emit('SIGTERM');
  assert.deepEqual([signals, exits], [['SIGTERM'], []]);
  proc.emit('SIGINT');
  assert.deepEqual([signals, exits], [['SIGTERM'], [1]]);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [1, 0]);

  const failing = new EventEmitter();
  /** @type {number[]} */
  const failedExits = [];
  installSignalHandlers(/** @type {any} */ (failing), () => Promise.reject(new Error('disk gone')), (code) => failedExits.push(code));
  failing.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failedExits, [1]);
});

test('the package entry point exports the documented building blocks', () => {
  for (const name of ['start', 'loadConfig', 'createApp', 'LinkService', 'MemoryStore', 'FileStore', 'AppError', 'importLinks']) {
    assert.equal(typeof (/** @type {any} */ (api)[name]), 'function', name);
  }
});
