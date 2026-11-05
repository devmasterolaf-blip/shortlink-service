/**
 * Process configuration from environment variables.
 *
 * Every setting is a `SHORTLINK_*` variable. `loadConfig` validates all of
 * them and reports every problem at once, so a broken deployment does not
 * have to be fixed one restart at a time.
 */

import { ConfigError } from './errors.js';
import { parseApiKeys } from './security/apiKeys.js';
import { DEFAULT_ALLOWED_SCHEMES, DEFAULT_MAX_URL_LENGTH } from './url/validate.js';

const PREFIX = 'SHORTLINK_';

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {string} host
 * @property {string} baseUrl public origin of the service, used to build short URLs
 * @property {'memory' | 'file'} store
 * @property {string} dataFile
 * @property {'always' | 'never'} fsync
 * @property {'counter' | 'random'} codeStrategy
 * @property {number} codeLength
 * @property {string | undefined} codeSecret
 * @property {Array<import('./security/apiKeys.js').ApiKey & { secret: string }>} apiKeys
 * @property {number} rateLimitCapacity
 * @property {number} rateLimitRefillPerSec
 * @property {number} maxBodyBytes
 * @property {number} maxImportBytes
 * @property {number} maxUrlLength
 * @property {string[]} allowedSchemes
 * @property {boolean} blockPrivateHosts
 * @property {301 | 302 | 307} defaultRedirect
 * @property {number} permanentMaxAge
 * @property {boolean} trustProxy
 * @property {string | undefined} visitorSecret
 * @property {number} statsRetentionDays
 * @property {number} shutdownGraceMs
 * @property {'info' | 'error' | 'silent'} logLevel
 */

/**
 * Reads variables, remembers which ones were consumed and collects problems.
 */
class EnvReader {
  /** @param {Record<string, string | undefined>} env */
  constructor(env) {
    this.env = env;
    /** @type {string[]} */
    this.problems = [];
    /** @type {Set<string>} */
    this.known = new Set();
  }

  /**
   * @param {string} name without the prefix
   * @returns {string | undefined} trimmed value; undefined when unset or empty
   */
  raw(name) {
    this.known.add(PREFIX + name);
    const value = this.env[PREFIX + name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  }

  /** @param {string} name @param {string} message */
  fail(name, message) {
    this.problems.push(`${PREFIX}${name} ${message}`);
  }

  /** @param {string} name @param {string} fallback */
  string(name, fallback) {
    return this.raw(name) ?? fallback;
  }

  /**
   * @param {string} name
   * @param {number} fallback
   * @param {{ min: number, max: number, integer?: boolean }} range
   */
  number(name, fallback, { min, max, integer = true }) {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    const valid = /^\d+(\.\d+)?$/.test(value) && parsed >= min && parsed <= max && (!integer || Number.isInteger(parsed));
    if (!valid) {
      this.fail(name, `must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max} (got "${value}")`);
      return fallback;
    }
    return parsed;
  }

  /** @param {string} name @param {boolean} fallback */
  boolean(name, fallback) {
    const value = this.raw(name)?.toLowerCase();
    if (value === undefined) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    this.fail(name, `must be true or false (got "${value}")`);
    return fallback;
  }

  /**
   * @template {string} T
   * @param {string} name
   * @param {readonly T[]} choices
   * @param {T} fallback
   * @returns {T}
   */
  choice(name, choices, fallback) {
    const value = this.raw(name)?.toLowerCase();
    if (value === undefined) return fallback;
    if (!choices.includes(/** @type {T} */ (value))) {
      this.fail(name, `must be one of: ${choices.join(', ')} (got "${value}")`);
      return fallback;
    }
    return /** @type {T} */ (value);
  }
}

/**
 * @param {EnvReader} reader
 * @param {number} port
 * @returns {string}
 */
function readBaseUrl(reader, port) {
  const fallback = `http://localhost:${port}`;
  const value = reader.raw('BASE_URL');
  if (value === undefined) return fallback;
  /** @type {URL} */
  let url;
  try {
    url = new URL(value);
  } catch {
    reader.fail('BASE_URL', `must be an absolute URL (got "${value}")`);
    return fallback;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    reader.fail('BASE_URL', 'must use http or https');
  } else if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    // Short links are served from the root of the origin.
    reader.fail('BASE_URL', 'must be a bare origin such as https://sho.rt (no path, query or credentials)');
  }
  return url.origin;
}

/**
 * Load and validate the configuration.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Config}
 * @throws {ConfigError} listing every invalid or unknown variable
 */
export function loadConfig(env = process.env) {
  const reader = new EnvReader(env);

  const port = reader.number('PORT', 8080, { min: 0, max: 65535 });
  const store = reader.choice('STORE', /** @type {const} */ (['memory', 'file']), 'memory');
  const codeStrategy = reader.choice('CODE_STRATEGY', /** @type {const} */ (['counter', 'random']), 'counter');

  /** @type {Config['apiKeys']} */
  let apiKeys = [];
  try {
    apiKeys = parseApiKeys(reader.raw('API_KEYS') ?? '');
  } catch (err) {
    reader.fail('API_KEYS', `is invalid: ${/** @type {Error} */ (err).message}`);
  }

  const allowedSchemes = (reader.raw('ALLOWED_SCHEMES') ?? DEFAULT_ALLOWED_SCHEMES.join(','))
    .split(',')
    .map((scheme) => scheme.trim().toLowerCase().replace(/:$/, ''))
    .filter((scheme) => scheme !== '');
  const badScheme = allowedSchemes.find((scheme) => !/^[a-z][a-z0-9+.-]*$/.test(scheme));
  if (badScheme !== undefined) reader.fail('ALLOWED_SCHEMES', `contains an invalid scheme "${badScheme}"`);
  if (allowedSchemes.length === 0) reader.fail('ALLOWED_SCHEMES', 'must list at least one scheme');

  const visitorSecret = reader.raw('VISITOR_SECRET');
  if (visitorSecret !== undefined && visitorSecret.length < 16) {
    reader.fail('VISITOR_SECRET', 'must be at least 16 characters long');
  }

  /** @type {Config} */
  const config = {
    port,
    host: reader.string('HOST', '127.0.0.1'),
    baseUrl: readBaseUrl(reader, port),
    store,
    dataFile: reader.string('DATA_FILE', 'data/links.jsonl'),
    fsync: reader.choice('FSYNC', /** @type {const} */ (['always', 'never']), 'always'),
    codeStrategy,
    codeLength: reader.number('CODE_LENGTH', codeStrategy === 'random' ? 7 : 5, { min: 4, max: 12 }),
    codeSecret: reader.raw('CODE_SECRET'),
    apiKeys,
    rateLimitCapacity: reader.number('RATE_LIMIT_CAPACITY', 60, { min: 1, max: 1_000_000 }),
    rateLimitRefillPerSec: reader.number('RATE_LIMIT_REFILL_PER_SEC', 1, { min: 0.001, max: 100_000, integer: false }),
    maxBodyBytes: reader.number('MAX_BODY_BYTES', 16 * 1024, { min: 256, max: 1024 * 1024 }),
    maxImportBytes: reader.number('MAX_IMPORT_BYTES', 5 * 1024 * 1024, { min: 1024, max: 256 * 1024 * 1024 }),
    maxUrlLength: reader.number('MAX_URL_LENGTH', DEFAULT_MAX_URL_LENGTH, { min: 16, max: 65536 }),
    allowedSchemes,
    blockPrivateHosts: reader.boolean('BLOCK_PRIVATE_HOSTS', false),
    defaultRedirect: /** @type {301 | 302 | 307} */ (
      Number(reader.choice('DEFAULT_REDIRECT', /** @type {const} */ (['301', '302', '307']), '302'))
    ),
    permanentMaxAge: reader.number('PERMANENT_MAX_AGE', 86_400, { min: 0, max: 31_536_000 }),
    trustProxy: reader.boolean('TRUST_PROXY', false),
    visitorSecret,
    statsRetentionDays: reader.number('STATS_RETENTION_DAYS', 90, { min: 1, max: 3650 }),
    shutdownGraceMs: reader.number('SHUTDOWN_GRACE_MS', 10_000, { min: 0, max: 600_000 }),
    logLevel: reader.choice('LOG_LEVEL', /** @type {const} */ (['info', 'error', 'silent']), 'info'),
  };

  // A misspelt variable would otherwise be ignored silently.
  for (const name of Object.keys(env)) {
    if (name.startsWith(PREFIX) && !reader.known.has(name)) {
      reader.problems.push(`${name} is not a known setting`);
    }
  }
  if (reader.problems.length > 0) throw new ConfigError(reader.problems);
  return config;
}
