#!/usr/bin/env node
/**
 * Server entry point: `node src/main.js` (or `npm start`).
 */

import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';
import { createLogger } from './logger.js';
import { installSignalHandlers, start } from './serve.js';

try {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const running = await start(config, { logger });
  installSignalHandlers(
    process,
    async (signal) => {
      logger.info('shutting down', { signal });
      await running.close();
    },
    (code) => process.exit(code),
  );
} catch (err) {
  // Configuration problems are for the operator: print them without a stack trace.
  console.error(err instanceof ConfigError ? err.message : err);
  process.exitCode = 1;
}
