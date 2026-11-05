/**
 * Server lifecycle: start listening, shut down gracefully.
 */

import { systemClock } from './clock.js';
import { createApp } from './http/app.js';
import { silentLogger } from './http/middleware.js';
import { createHttpServer } from './http/server.js';
import { createRuntime } from './runtime.js';
import { ApiKeyRegistry } from './security/apiKeys.js';
import { TokenBucketLimiter } from './security/rateLimiter.js';

const SWEEP_INTERVAL_MS = 60_000;

/**
 * @typedef {object} RunningServer
 * @property {number} port the port actually bound (useful when the configured port is 0)
 * @property {string} host
 * @property {import('./runtime.js').Runtime} runtime
 * @property {() => Promise<void>} close finish in-flight requests, stop listening and close the store; idempotent
 */

/**
 * Build everything from the configuration and start listening.
 * @param {import('./config.js').Config} config
 * @param {{ logger?: import('./http/middleware.js').Logger, clock?: import('./clock.js').Clock }} [options]
 * @returns {Promise<RunningServer>}
 */
export async function start(config, options = {}) {
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? systemClock;
  const runtime = createRuntime(config, { clock });
  const rateLimiter = new TokenBucketLimiter({
    capacity: config.rateLimitCapacity,
    refillPerSecond: config.rateLimitRefillPerSec,
    clock,
  });
  const managed = createHttpServer(
    createApp({
      service: runtime.service,
      apiKeys: new ApiKeyRegistry(config.apiKeys),
      rateLimiter,
      maxBodyBytes: config.maxBodyBytes,
      maxImportBytes: config.maxImportBytes,
      trustProxy: config.trustProxy,
      logger,
      clock,
    }),
    { shutdownGraceMs: config.shutdownGraceMs },
  );

  /** @type {{ port: number, host: string }} */
  let address;
  try {
    address = await managed.listen(config.port, config.host);
  } catch (err) {
    runtime.close();
    throw err;
  }
  const sweeper = setInterval(() => rateLimiter.sweep(), SWEEP_INTERVAL_MS);
  sweeper.unref();

  logger.info('listening', { host: address.host, port: address.port, store: config.store, baseUrl: config.baseUrl });
  if (config.apiKeys.length === 0) {
    logger.error('no API keys are configured: every /api request will be rejected');
  }

  /** @type {Promise<void> | null} */
  let closing = null;
  return {
    ...address,
    runtime,
    close() {
      closing ??= (async () => {
        clearInterval(sweeper);
        try {
          await managed.close();
        } finally {
          runtime.close();
        }
        logger.info('stopped');
      })();
      return closing;
    },
  };
}

/**
 * Shut down on SIGINT/SIGTERM. The first signal starts a graceful
 * shutdown; a second one while it is still running exits immediately.
 *
 * @param {Pick<NodeJS.Process, 'on'>} proc
 * @param {(signal: string) => Promise<void>} shutdown
 * @param {(code: number) => void} exit
 */
export function installSignalHandlers(proc, shutdown, exit) {
  let shuttingDown = false;
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    proc.on(signal, () => {
      if (shuttingDown) {
        exit(1);
        return;
      }
      shuttingDown = true;
      shutdown(signal).then(
        () => exit(0),
        () => exit(1),
      );
    });
  }
}
