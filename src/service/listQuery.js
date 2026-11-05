/**
 * Parsing and execution of link list queries: filtering, sorting and
 * page-based pagination. Query values arrive as strings (from a URL query
 * string or CLI flags), so everything is parsed and validated here.
 */

import { ValidationError } from '../errors.js';
import { parseTimestamp } from './linkInput.js';
import { linkStatus } from './linkStatus.js';

/** @typedef {import('../storage/memoryStore.js').Link} Link */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const SORT_FIELDS = Object.freeze(['createdAt', 'updatedAt', 'clicks', 'code', 'expiresAt', 'lastClickAt']);
const STATUSES = Object.freeze(['active', 'disabled', 'expired', 'exhausted']);
const QUERY_FIELDS = Object.freeze([
  'page',
  'pageSize',
  'sort',
  'tag',
  'enabled',
  'status',
  'q',
  'createdAfter',
  'createdBefore',
]);

/**
 * @typedef {object} ListQuery
 * @property {number} page 1-based
 * @property {number} pageSize
 * @property {{ field: string, descending: boolean }} sort
 * @property {string[]} tags a link must carry all of them
 * @property {boolean} [enabled]
 * @property {import('./linkStatus.js').LinkStatus} [status]
 * @property {string} [q] case-insensitive substring of the code or the URL
 * @property {number} [createdAfter] inclusive lower bound, epoch milliseconds
 * @property {number} [createdBefore] exclusive upper bound, epoch milliseconds
 */

/**
 * @param {string} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseIntInRange(value, field, min, max) {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max}`, { field });
  }
  return Number(value);
}

/**
 * @param {Record<string, string | undefined>} raw
 * @returns {ListQuery}
 */
export function parseListQuery(raw = {}) {
  const unknown = Object.keys(raw).filter((key) => !QUERY_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, {
      code: 'unknown_field',
      details: { fields: unknown, allowed: QUERY_FIELDS },
    });
  }

  /** @type {ListQuery} */
  const query = {
    page: raw.page === undefined ? 1 : parseIntInRange(raw.page, 'page', 1, Number.MAX_SAFE_INTEGER),
    pageSize:
      raw.pageSize === undefined ? DEFAULT_PAGE_SIZE : parseIntInRange(raw.pageSize, 'pageSize', 1, MAX_PAGE_SIZE),
    sort: { field: 'createdAt', descending: true },
    tags: [],
  };

  if (raw.sort !== undefined) {
    const descending = raw.sort.startsWith('-');
    const field = descending ? raw.sort.slice(1) : raw.sort;
    if (!SORT_FIELDS.includes(field)) {
      throw new ValidationError(
        `sort must be one of ${SORT_FIELDS.join(', ')}, optionally prefixed with "-" for descending order`,
        { field: 'sort' },
      );
    }
    query.sort = { field, descending };
  }
  if (raw.tag !== undefined) {
    query.tags = raw.tag
      .split(',')
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag !== '');
  }
  if (raw.enabled !== undefined) {
    if (raw.enabled !== 'true' && raw.enabled !== 'false') {
      throw new ValidationError('enabled must be "true" or "false"', { field: 'enabled' });
    }
    query.enabled = raw.enabled === 'true';
  }
  if (raw.status !== undefined) {
    if (!STATUSES.includes(raw.status)) {
      throw new ValidationError(`status must be one of ${STATUSES.join(', ')}`, { field: 'status' });
    }
    query.status = /** @type {ListQuery['status']} */ (raw.status);
  }
  if (raw.q !== undefined && raw.q !== '') {
    if (raw.q.length > 200) throw new ValidationError('q must be at most 200 characters', { field: 'q' });
    query.q = raw.q.toLowerCase();
  }
  for (const field of /** @type {const} */ (['createdAfter', 'createdBefore'])) {
    const value = raw[field];
    if (value !== undefined) query[field] = parseTimestamp(/^\d+$/.test(value) ? Number(value) : value, field);
  }
  return query;
}

/**
 * @param {Link} link
 * @param {ListQuery} query
 * @param {number} now
 * @returns {boolean}
 */
function matches(link, query, now) {
  if (query.enabled !== undefined && link.enabled !== query.enabled) return false;
  if (query.status !== undefined && linkStatus(link, now) !== query.status) return false;
  if (!query.tags.every((tag) => link.tags.includes(tag))) return false;
  if (query.createdAfter !== undefined && link.createdAt < query.createdAfter) return false;
  if (query.createdBefore !== undefined && link.createdAt >= query.createdBefore) return false;
  if (query.q !== undefined) {
    if (!link.code.toLowerCase().includes(query.q) && !link.url.toLowerCase().includes(query.q)) return false;
  }
  return true;
}

/**
 * Comparator for one sort field. Links without a value (no expiry, never
 * clicked) sort after all links that have one, in both directions; ties are
 * broken by code so pagination is stable.
 * @param {ListQuery['sort']} sort
 * @returns {(a: Link, b: Link) => number}
 */
function comparator({ field, descending }) {
  const direction = descending ? -1 : 1;
  return (a, b) => {
    const left = /** @type {string | number | null} */ (a[/** @type {keyof Link} */ (field)]);
    const right = /** @type {string | number | null} */ (b[/** @type {keyof Link} */ (field)]);
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      return (left < right ? -1 : 1) * direction;
    }
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  };
}

/**
 * @template T
 * @typedef {object} Page
 * @property {T[]} items
 * @property {number} page
 * @property {number} pageSize
 * @property {number} total matching items across all pages
 * @property {number} totalPages
 */

/**
 * Filter, sort and paginate links.
 * @param {Link[]} links
 * @param {ListQuery} query
 * @param {number} now
 * @returns {Page<Link>}
 */
export function runListQuery(links, query, now) {
  const matching = links.filter((link) => matches(link, query, now)).sort(comparator(query.sort));
  const start = (query.page - 1) * query.pageSize;
  return {
    items: matching.slice(start, start + query.pageSize),
    page: query.page,
    pageSize: query.pageSize,
    total: matching.length,
    totalPages: Math.ceil(matching.length / query.pageSize),
  };
}
