/**
 * Bulk export and import of links as JSON or CSV.
 *
 * Exports carry the stored fields of every link, including the password
 * hash, so that an export can be restored elsewhere. Per-day statistics
 * are not part of an export.
 */

import { AppError, ConflictError, ValidationError } from '../errors.js';
import { validateAlias } from '../codes/alias.js';
import { hashPassword, isPasswordHash } from '../security/password.js';
import {
  assertPlainObject,
  parseEnabled,
  parseMaxClicks,
  parsePassword,
  parseRedirectType,
  parseTags,
  parseTimestamp,
  rejectUnknownFields,
} from '../service/linkInput.js';
import { normalizeUrl } from '../url/validate.js';
import { formatCsv, parseCsvRecords } from './csv.js';

/** @typedef {import('../storage/memoryStore.js').Link} Link */
/** @typedef {import('../service/linkService.js').LinkService} LinkService */

export const EXPORT_VERSION = 1;

/** Fields of an exported link, in CSV column order. */
export const EXPORT_FIELDS = Object.freeze([
  'code',
  'url',
  'custom',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'maxClicks',
  'clicks',
  'lastClickAt',
  'enabled',
  'tags',
  'redirectType',
  'passwordHash',
]);

/** Import additionally accepts a plain password, which is hashed on the way in. */
const IMPORT_FIELDS = Object.freeze([...EXPORT_FIELDS, 'password']);
const TAG_SEPARATOR = '|';
export const CONFLICT_POLICIES = Object.freeze(['skip', 'error', 'overwrite']);

/** @param {number | null} ms */
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

/**
 * @param {Link} link
 * @returns {Record<string, unknown>}
 */
function toExportRecord(link) {
  const values = {
    ...link,
    createdAt: iso(link.createdAt),
    updatedAt: iso(link.updatedAt),
    expiresAt: iso(link.expiresAt),
    lastClickAt: iso(link.lastClickAt),
  };
  // Same field order in JSON as in the CSV header.
  return Object.fromEntries(EXPORT_FIELDS.map((field) => [field, values[/** @type {keyof Link} */ (field)]]));
}

/**
 * @param {import('../storage/memoryStore.js').LinkStore} store
 * @param {number} now
 * @returns {string} a JSON document `{ version, exportedAt, links }`
 */
export function exportJson(store, now) {
  const document = {
    version: EXPORT_VERSION,
    exportedAt: iso(now),
    links: store.listLinks().map(toExportRecord),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * @param {import('../storage/memoryStore.js').LinkStore} store
 * @returns {string} CSV with a header row; tags are joined with `|`
 */
export function exportCsv(store) {
  const rows = store.listLinks().map((link) => {
    const record = toExportRecord(link);
    return EXPORT_FIELDS.map((field) => {
      const value = record[field];
      if (value === null) return '';
      return Array.isArray(value) ? value.join(TAG_SEPARATOR) : String(value);
    });
  });
  return formatCsv([[...EXPORT_FIELDS], ...rows]);
}

/**
 * Turn the text cells of one CSV record into the typed values the JSON
 * form would carry. Cells that do not look right are left as text so that
 * validation reports them against the proper field.
 * @param {Record<string, string>} cells
 * @returns {Record<string, unknown>}
 */
function csvRecordToRaw(cells) {
  /** @type {Record<string, unknown>} */
  const raw = {};
  for (const [field, text] of Object.entries(cells)) {
    const value = text.trim();
    if (value === '') continue;
    if (field === 'maxClicks' || field === 'clicks' || field === 'redirectType') {
      raw[field] = /^\d+$/.test(value) ? Number(value) : value;
    } else if (field === 'enabled' || field === 'custom') {
      const lower = value.toLowerCase();
      raw[field] = lower === 'true' ? true : lower === 'false' ? false : value;
    } else if (field === 'tags') {
      raw[field] = value.split(TAG_SEPARATOR).map((tag) => tag.trim()).filter((tag) => tag !== '');
    } else {
      raw[field] = field === 'password' ? text : value;
    }
  }
  return raw;
}

/**
 * Parse an import document into raw records (not yet validated).
 * @param {string} text
 * @param {'json' | 'csv'} format
 * @returns {unknown[]}
 */
export function parseImport(text, format) {
  if (format === 'csv') {
    const { columns, records } = parseCsvRecords(text);
    const unknown = columns.filter((name) => !IMPORT_FIELDS.includes(name));
    if (unknown.length > 0) {
      throw new ValidationError(`Unknown CSV column(s): ${unknown.join(', ')}`, {
        code: 'unknown_field',
        details: { unknown, allowed: IMPORT_FIELDS },
      });
    }
    if (!columns.includes('url')) {
      throw new ValidationError('The CSV header must include a "url" column', { code: 'csv_invalid' });
    }
    return records.map(csvRecordToRaw);
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ValidationError(`Import is not valid JSON: ${/** @type {Error} */ (err).message}`, {
      code: 'invalid_json',
    });
  }
  const links = Array.isArray(parsed) ? parsed : /** @type {any} */ (parsed)?.links;
  if (!Array.isArray(links)) {
    throw new ValidationError('A JSON import must be an array of links or an object with a "links" array', {
      code: 'import_invalid',
    });
  }
  return links;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function parseCount(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`, { field });
  }
  return value;
}

/**
 * Validate one raw record against the same rules as the API, except that
 * history (timestamps in the past, click counts, password hashes) is
 * accepted as given.
 * @param {LinkService} service
 * @param {unknown} raw
 * @returns {{ link: Omit<Link, 'code'> & { code: string | null }, password: string | null }}
 */
function parseImportRecord(service, raw) {
  const input = assertPlainObject(raw, 'Link');
  rejectUnknownFields(input, IMPORT_FIELDS);
  const present = (/** @type {string} */ field) => input[field] !== undefined && input[field] !== null;
  const now = service.clock.now();

  const { url } = normalizeUrl(input.url, service.urlPolicy);
  const code = present('code') ? validateAlias(input.code, { reserved: service.reservedWords }) : null;
  const createdAt = present('createdAt') ? parseTimestamp(input.createdAt, 'createdAt') : now;
  const updatedAt = present('updatedAt') ? parseTimestamp(input.updatedAt, 'updatedAt') : createdAt;
  if (present('password') && present('passwordHash')) {
    throw new ValidationError('Give either password or passwordHash, not both', { field: 'password' });
  }
  if (present('passwordHash') && !isPasswordHash(input.passwordHash)) {
    throw new ValidationError('passwordHash is not a hash produced by this service', { field: 'passwordHash' });
  }
  return {
    link: {
      code,
      url,
      custom: present('custom') ? parseEnabled(input.custom, 'custom') : code !== null,
      createdAt,
      updatedAt,
      expiresAt: present('expiresAt') ? parseTimestamp(input.expiresAt, 'expiresAt') : null,
      maxClicks: present('maxClicks') ? parseMaxClicks(input.maxClicks) : null,
      clicks: present('clicks') ? parseCount(input.clicks, 'clicks') : 0,
      lastClickAt: present('lastClickAt') ? parseTimestamp(input.lastClickAt, 'lastClickAt') : null,
      passwordHash: present('passwordHash') ? /** @type {string} */ (input.passwordHash) : null,
      enabled: present('enabled') ? parseEnabled(input.enabled) : true,
      tags: present('tags') ? parseTags(input.tags) : [],
      redirectType: present('redirectType') ? parseRedirectType(input.redirectType) : service.defaultRedirectType,
    },
    password: present('password') ? parsePassword(input.password) : null,
  };
}

/**
 * @typedef {object} ImportSummary
 * @property {number} total records in the document
 * @property {number} created
 * @property {number} overwritten
 * @property {number} skipped existing codes left alone (`onConflict: 'skip'`)
 * @property {number} failed
 * @property {boolean} dryRun true when nothing was written
 * @property {Array<{ index: number, code: string | null, error: { code: string, message: string } }>} errors
 *   one entry per failed record; `index` is the 0-based position in the document
 */

/**
 * Import raw records one by one. Records are independent: a bad record is
 * reported and the rest are still imported.
 *
 * @param {LinkService} service
 * @param {unknown[]} records
 * @param {{ onConflict?: 'skip' | 'error' | 'overwrite', dryRun?: boolean }} [options]
 * @returns {Promise<ImportSummary>}
 */
export async function importLinks(service, records, options = {}) {
  const onConflict = options.onConflict ?? 'skip';
  const dryRun = options.dryRun ?? false;
  if (!CONFLICT_POLICIES.includes(onConflict)) {
    throw new ValidationError(`onConflict must be one of: ${CONFLICT_POLICIES.join(', ')}`, { field: 'onConflict' });
  }
  const { store } = service;
  /** @type {ImportSummary} */
  const summary = { total: records.length, created: 0, overwritten: 0, skipped: 0, failed: 0, dryRun, errors: [] };
  /** Codes claimed earlier in this document, so a dry run sees in-file duplicates too. */
  const claimed = new Set();

  for (const [index, raw] of records.entries()) {
    /** @type {string | null} */
    let code = null;
    try {
      const { link, password } = parseImportRecord(service, raw);
      code = link.code;
      const exists = code !== null && (store.hasLink(code) || claimed.has(code));
      if (exists && onConflict === 'skip') {
        summary.skipped += 1;
        continue;
      }
      if (exists && onConflict === 'error') {
        throw new ConflictError(`Code "${code}" is already in use`, { code: 'code_taken' });
      }
      if (password !== null && !dryRun) link.passwordHash = await hashPassword(password, service.passwordCost);
      if (!dryRun) {
        const stored = { ...link, code: code ?? service.allocateCode() };
        if (store.hasLink(stored.code)) store.updateLink(stored.code, stored);
        else store.insertLink(stored);
      }
      if (code !== null) claimed.add(code);
      if (exists) summary.overwritten += 1;
      else summary.created += 1;
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      summary.failed += 1;
      summary.errors.push({ index, code, error: { code: err.code, message: err.message } });
    }
  }
  return summary;
}
