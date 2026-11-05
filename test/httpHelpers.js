/**
 * Helpers for tests that exercise the real HTTP stack. Every server listens
 * on an ephemeral port and is closed when the owning test finishes.
 */

import { ManualClock } from '../src/clock.js';
import { CodePermutation } from '../src/codes/base62.js';
import { CounterCodeGenerator } from '../src/codes/generator.js';
import { createApp } from '../src/http/app.js';
import { createHttpServer } from '../src/http/server.js';
import { ApiKeyRegistry } from '../src/security/apiKeys.js';
import { TokenBucketLimiter } from '../src/security/rateLimiter.js';
import { LinkService } from '../src/service/linkService.js';
import { MemoryStore } from '../src/storage/memoryStore.js';
import { VisitorHasher } from '../src/analytics/visitors.js';
import { FAST_COST, T0 } from './helpers.js';

export const KEYS = Object.freeze({
  admin: 'admin-key-0123456789abcdef',
  writer: 'writer-key-0123456789abcdef',
  reader: 'reader-key-0123456789abcdef',
  stats: 'stats-key-0123456789abcdef',
});

const KEY_SPEC = [
  `admin:${KEYS.admin}:*`,
  `writer:${KEYS.writer}:links:read+links:write`,
  `reader:${KEYS.reader}:links:read`,
  `stats:${KEYS.stats}:stats:read`,
].join(',');

/**
 * Start the application on an ephemeral port.
 * @param {import('node:test').TestContext} t the server is closed in `t.after`
 * @param {{ app?: Partial<import('../src/http/app.js').AppOptions>, service?: Partial<import('../src/service/linkService.js').LinkServiceOptions>, rate?: { capacity: number, refillPerSecond: number } }} [options]
 */
export async function startApp(t, options = {}) {
  const clock = new ManualClock(T0);
  const store = options.service?.store ?? new MemoryStore();
  const service = new LinkService({
    store,
    generator: new CounterCodeGenerator({ store, permutation: new CodePermutation({ minLength: 4 }) }),
    clock,
    baseUrl: 'https://sho.rt',
    passwordCost: FAST_COST,
    visitorHasher: new VisitorHasher({ secret: 'test' }),
    ...options.service,
  });
  const rateLimiter = new TokenBucketLimiter({ capacity: 1000, refillPerSecond: 1000, clock, ...options.rate });
  const handler = createApp({
    service,
    apiKeys: ApiKeyRegistry.fromSpec(KEY_SPEC),
    rateLimiter,
    clock,
    ...options.app,
  });
  const managed = createHttpServer(handler, { shutdownGraceMs: 200 });
  const { port } = await managed.listen(0);
  t.after(() => managed.close());
  const origin = `http://127.0.0.1:${port}`;

  /**
   * Call the API. Redirects are never followed and every request uses its
   * own connection, so closing the server never waits on a pooled socket.
   * @param {string} method
   * @param {string} path
   * @param {{ key?: string | null, body?: unknown, headers?: Record<string, string>, raw?: string | Uint8Array }} [init]
   */
  async function api(method, path, init = {}) {
    /** @type {Record<string, string>} */
    const headers = { Connection: 'close', ...init.headers };
    const key = init.key === undefined ? KEYS.admin : init.key;
    if (key !== null) headers.Authorization = `Bearer ${key}`;
    /** @type {string | Uint8Array | undefined} */
    let body = init.raw;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers['Content-Type'] ??= 'application/json';
    }
    const response = await fetch(origin + path, { method, headers, body, redirect: 'manual' });
    const text = await response.text();
    /** @type {any} */
    let json;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  return { api, origin, service, store, clock, rateLimiter, port };
}
