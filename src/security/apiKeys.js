/**
 * API keys with scopes.
 *
 * Keys are configured as a comma-separated list of `name:secret:scopes`
 * entries, where scopes are joined with "+", for example
 *
 *   ci:3f9c1d0a7b2e4c68a1d5:links:read+links:write,ops:8b7a6c5d4e3f2a1b0c9d:*
 *
 * Only SHA-256 digests of the secrets are kept in memory, and a presented
 * key is compared against every configured digest in constant time, so the
 * response time does not reveal which key (if any) came close.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { ValidationError } from '../errors.js';

export const SCOPES = Object.freeze(['links:read', 'links:write', 'stats:read', 'admin']);
export const ALL_SCOPES = '*';
export const MIN_SECRET_LENGTH = 16;

/**
 * @typedef {object} ApiKey
 * @property {string} name label used in logs and as the rate-limit identity
 * @property {readonly string[]} scopes granted scopes, or `['*']`
 */

/**
 * @param {string} secret
 * @returns {Buffer}
 */
function digest(secret) {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Parse the textual key list. Throws a ValidationError describing the first
 * problem; the secret itself is never included in a message.
 * @param {string} spec
 * @returns {Array<ApiKey & { secret: string }>}
 */
export function parseApiKeys(spec) {
  /** @type {Array<ApiKey & { secret: string }>} */
  const keys = [];
  for (const [index, rawEntry] of spec.split(',').entries()) {
    const entry = rawEntry.trim();
    if (entry === '') continue;
    const position = `API key entry ${index + 1}`;
    const firstColon = entry.indexOf(':');
    const secondColon = entry.indexOf(':', firstColon + 1);
    if (firstColon < 1 || secondColon < 0) {
      throw new ValidationError(`${position} must look like name:secret:scopes`);
    }
    const name = entry.slice(0, firstColon);
    const secret = entry.slice(firstColon + 1, secondColon);
    const scopes = entry.slice(secondColon + 1).split('+').map((scope) => scope.trim());
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) {
      throw new ValidationError(`${position} has an invalid name (use letters, digits, "-" and "_")`);
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new ValidationError(`${position} ("${name}") needs a secret of at least ${MIN_SECRET_LENGTH} characters`);
    }
    const unknown = scopes.filter((scope) => scope !== ALL_SCOPES && !SCOPES.includes(scope));
    if (unknown.length > 0 || scopes.length === 0) {
      throw new ValidationError(
        `${position} ("${name}") has unknown scope ${JSON.stringify(unknown[0] ?? '')}; valid scopes: ${SCOPES.join(', ')}, ${ALL_SCOPES}`,
      );
    }
    if (keys.some((key) => key.name === name)) {
      throw new ValidationError(`${position} reuses the name "${name}"`);
    }
    if (keys.some((key) => key.secret === secret)) {
      throw new ValidationError(`${position} ("${name}") reuses the secret of another key`);
    }
    keys.push({ name, secret, scopes: Object.freeze([...new Set(scopes)]) });
  }
  return keys;
}

export class ApiKeyRegistry {
  /** @param {Array<ApiKey & { secret: string }>} [keys] */
  constructor(keys = []) {
    /** @type {Array<{ key: ApiKey, digest: Buffer }>} */
    this.entries = keys.map(({ name, scopes, secret }) => ({
      key: Object.freeze({ name, scopes }),
      digest: digest(secret),
    }));
  }

  /** @param {string} spec @returns {ApiKeyRegistry} */
  static fromSpec(spec) {
    return new ApiKeyRegistry(parseApiKeys(spec));
  }

  get size() {
    return this.entries.length;
  }

  /**
   * @param {unknown} presented secret sent by the client
   * @returns {ApiKey | null}
   */
  authenticate(presented) {
    if (typeof presented !== 'string' || presented === '') return null;
    const candidate = digest(presented);
    /** @type {ApiKey | null} */
    let found = null;
    // No early exit: every entry is compared on every call.
    for (const entry of this.entries) {
      if (timingSafeEqual(candidate, entry.digest)) found = entry.key;
    }
    return found;
  }
}

/**
 * @param {ApiKey} key
 * @param {string} scope
 * @returns {boolean}
 */
export function hasScope(key, scope) {
  return key.scopes.includes(ALL_SCOPES) || key.scopes.includes(scope);
}
