/**
 * Field-level validation of link input shared by the API, the importer and
 * the CLI. Every function throws a {@link ValidationError} that names the
 * offending field.
 */

import { ValidationError } from '../errors.js';

export const MAX_TAGS = 10;
export const MAX_CLICKS_LIMIT = 1_000_000_000;
export const PASSWORD_MIN_LENGTH = 4;
export const PASSWORD_MAX_LENGTH = 128;
export const REDIRECT_TYPES = Object.freeze([301, 302, 307]);

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {Record<string, unknown>}
 */
export function assertPlainObject(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${what} must be a JSON object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {Record<string, unknown>} input
 * @param {readonly string[]} allowed
 */
export function rejectUnknownFields(input, allowed) {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, {
      code: 'unknown_field',
      details: { fields: unknown, allowed },
    });
  }
}

/**
 * Parse a timestamp given as epoch milliseconds or as an ISO-8601 string.
 * Date-only strings mean midnight UTC; date-times must carry `Z` or an
 * explicit offset so the result never depends on the server's time zone.
 * @param {unknown} value
 * @param {string} field
 * @returns {number} epoch milliseconds
 */
export function parseTimestamp(value, field) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${field} must be a non-negative integer of epoch milliseconds`, { field });
    }
    return value;
  }
  if (typeof value === 'string' && ISO_TIMESTAMP.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  throw new ValidationError(
    `${field} must be epoch milliseconds or an ISO-8601 timestamp with a time zone`,
    { field },
  );
}

/**
 * Resolve the expiry of a link from `expiresAt` / `ttlSeconds`.
 * @param {Record<string, unknown>} input
 * @param {number} now
 * @returns {number | null | undefined} undefined when neither field is present
 */
export function parseExpiry(input, now) {
  const hasExpiresAt = input.expiresAt !== undefined;
  const hasTtl = input.ttlSeconds !== undefined;
  if (hasExpiresAt && hasTtl) {
    throw new ValidationError('Give either expiresAt or ttlSeconds, not both', { field: 'expiresAt' });
  }
  if (hasTtl) {
    const ttl = input.ttlSeconds;
    if (ttl === null) return null;
    if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0) {
      throw new ValidationError('ttlSeconds must be a positive integer', { field: 'ttlSeconds' });
    }
    return now + ttl * 1000;
  }
  if (!hasExpiresAt) return undefined;
  if (input.expiresAt === null) return null;
  const expiresAt = parseTimestamp(input.expiresAt, 'expiresAt');
  if (expiresAt <= now) {
    throw new ValidationError('expiresAt must be in the future', { field: 'expiresAt' });
  }
  return expiresAt;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseMaxClicks(value) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_CLICKS_LIMIT) {
    throw new ValidationError(`maxClicks must be an integer between 1 and ${MAX_CLICKS_LIMIT}, or null`, {
      field: 'maxClicks',
    });
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string | null} the password, or null to mean "no password"
 */
export function parsePassword(value) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError('password must be a string or null', { field: 'password' });
  }
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    throw new ValidationError(
      `password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters long`,
      { field: 'password' },
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function parseEnabled(value) {
  if (typeof value !== 'boolean') {
    throw new ValidationError('enabled must be true or false', { field: 'enabled' });
  }
  return value;
}

/**
 * Normalise tags: trimmed, lower-cased, de-duplicated, order preserved.
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseTags(value) {
  if (!Array.isArray(value)) throw new ValidationError('tags must be an array of strings', { field: 'tags' });
  /** @type {string[]} */
  const tags = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw new ValidationError('tags must be an array of strings', { field: 'tags' });
    const tag = raw.trim().toLowerCase();
    if (!TAG_PATTERN.test(tag)) {
      throw new ValidationError(
        `Invalid tag ${JSON.stringify(raw)}: use 1-32 letters, digits, "-" or "_", starting with a letter or digit`,
        { field: 'tags' },
      );
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) {
    throw new ValidationError(`A link can have at most ${MAX_TAGS} tags`, { field: 'tags' });
  }
  return tags;
}

/**
 * @param {unknown} value
 * @returns {301 | 302 | 307}
 */
export function parseRedirectType(value) {
  if (value !== 301 && value !== 302 && value !== 307) {
    throw new ValidationError('redirectType must be 301, 302 or 307', { field: 'redirectType' });
  }
  return value;
}
