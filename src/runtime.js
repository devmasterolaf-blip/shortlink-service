/**
 * Composition root: builds the store and the service from a validated
 * configuration. Shared by the HTTP server and the admin CLI so both see
 * links the same way.
 */

import { VisitorHasher } from './analytics/visitors.js';
import { systemClock } from './clock.js';
import { CodePermutation } from './codes/base62.js';
import { CounterCodeGenerator, RandomCodeGenerator } from './codes/generator.js';
import { LinkService } from './service/linkService.js';
import { FileStore } from './storage/fileStore.js';
import { MemoryStore } from './storage/memoryStore.js';
import { selfHostOf } from './url/validate.js';

/** A journal is compacted at start-up once it is this many times larger than a snapshot would be... */
const COMPACT_RATIO = 4;
/** ...and has at least this many records, so small files are left alone. */
const COMPACT_MIN_RECORDS = 1000;

/**
 * @param {import('./config.js').Config} config
 * @returns {MemoryStore | FileStore}
 */
export function openStore(config) {
  const statsLimits = { retentionDays: config.statsRetentionDays };
  if (config.store === 'memory') return new MemoryStore(statsLimits);
  const store = FileStore.open(config.dataFile, { fsync: config.fsync, statsLimits });
  // A snapshot needs at most two records per link (the link and its statistics) plus the counter.
  const snapshotRecords = 2 * store.countLinks() + 1;
  if (store.journalRecords >= COMPACT_MIN_RECORDS && store.journalRecords > COMPACT_RATIO * snapshotRecords) {
    store.compact();
  }
  return store;
}

/**
 * @typedef {object} Runtime
 * @property {MemoryStore | FileStore} store
 * @property {LinkService} service
 * @property {() => void} close flush and close the store
 */

/**
 * @param {import('./config.js').Config} config
 * @param {{ clock?: import('./clock.js').Clock }} [options]
 * @returns {Runtime}
 */
export function createRuntime(config, options = {}) {
  const store = openStore(config);
  const generator =
    config.codeStrategy === 'random'
      ? new RandomCodeGenerator({ length: config.codeLength })
      : new CounterCodeGenerator({
          store,
          permutation: new CodePermutation({ minLength: config.codeLength, secret: config.codeSecret }),
        });
  const service = new LinkService({
    store,
    generator,
    clock: options.clock ?? systemClock,
    baseUrl: config.baseUrl,
    urlPolicy: {
      allowedSchemes: config.allowedSchemes,
      maxLength: config.maxUrlLength,
      blockPrivateHosts: config.blockPrivateHosts,
      selfHosts: [selfHostOf(config.baseUrl)],
    },
    defaultRedirectType: config.defaultRedirect,
    permanentMaxAge: config.permanentMaxAge,
    visitorHasher: new VisitorHasher({ secret: config.visitorSecret }),
  });
  return { store, service, close: () => store.close() };
}
