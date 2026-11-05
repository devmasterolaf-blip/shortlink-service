/**
 * Service layer: every business rule about links lives here. It knows
 * nothing about HTTP and talks to storage only through the `LinkStore`
 * contract, so the API, the CLI and the importer all share one behaviour.
 */

import { AppError, ConflictError, NotFoundError } from '../errors.js';
import { systemClock } from '../clock.js';
import { DEFAULT_RESERVED_WORDS, isReservedWord, validateAlias } from '../codes/alias.js';
import { normalizeUrl } from '../url/validate.js';
import { DEFAULT_SCRYPT_COST, hashPassword } from '../security/password.js';
import {
  assertPlainObject,
  parseEnabled,
  parseExpiry,
  parseMaxClicks,
  parsePassword,
  parseRedirectType,
  parseTags,
  rejectUnknownFields,
} from './linkInput.js';

/**
 * @typedef {import('../storage/memoryStore.js').Link} Link
 * @typedef {import('../storage/memoryStore.js').LinkStore} LinkStore
 */

/**
 * @typedef {'active' | 'disabled' | 'expired' | 'exhausted'} LinkStatus
 */

/**
 * API representation of a link. Never exposes the password hash.
 * @typedef {object} PublicLink
 * @property {string} code
 * @property {string} shortUrl
 * @property {string} url
 * @property {boolean} custom
 * @property {string} createdAt ISO-8601
 * @property {string} updatedAt ISO-8601
 * @property {string | null} expiresAt ISO-8601
 * @property {number | null} maxClicks
 * @property {number} clicks
 * @property {string | null} lastClickAt ISO-8601
 * @property {boolean} hasPassword
 * @property {boolean} enabled
 * @property {string[]} tags
 * @property {301 | 302 | 307} redirectType
 * @property {LinkStatus} status
 */

/**
 * @typedef {object} LinkServiceOptions
 * @property {LinkStore} store
 * @property {import('../codes/generator.js').CodeGenerator} generator
 * @property {import('../clock.js').Clock} [clock]
 * @property {string} [baseUrl] public origin used to build `shortUrl`
 * @property {import('../url/validate.js').UrlPolicy} [urlPolicy]
 * @property {readonly string[]} [reservedWords]
 * @property {301 | 302 | 307} [defaultRedirectType]
 * @property {import('../security/password.js').ScryptCost} [passwordCost]
 * @property {number} [maxCodeAttempts] proposals tried before giving up on generating a code
 */

const CREATE_FIELDS = Object.freeze([
  'url',
  'alias',
  'expiresAt',
  'ttlSeconds',
  'maxClicks',
  'password',
  'enabled',
  'tags',
  'redirectType',
]);
const UPDATE_FIELDS = Object.freeze(CREATE_FIELDS.filter((field) => field !== 'alias'));

/**
 * @param {number | null} ms
 * @returns {string | null}
 */
function iso(ms) {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * @param {Link} link
 * @param {number} now
 * @returns {LinkStatus}
 */
export function linkStatus(link, now) {
  if (!link.enabled) return 'disabled';
  if (link.expiresAt !== null && link.expiresAt <= now) return 'expired';
  if (link.maxClicks !== null && link.clicks >= link.maxClicks) return 'exhausted';
  return 'active';
}

export class LinkService {
  /** @param {LinkServiceOptions} options */
  constructor(options) {
    this.store = options.store;
    this.generator = options.generator;
    this.clock = options.clock ?? systemClock;
    this.baseUrl = (options.baseUrl ?? 'http://localhost:8080').replace(/\/+$/, '');
    this.urlPolicy = options.urlPolicy ?? {};
    this.reservedWords = options.reservedWords ?? DEFAULT_RESERVED_WORDS;
    this.defaultRedirectType = options.defaultRedirectType ?? 302;
    this.passwordCost = options.passwordCost ?? DEFAULT_SCRYPT_COST;
    this.maxCodeAttempts = options.maxCodeAttempts ?? 12;
  }

  /**
   * @param {Link} link
   * @returns {PublicLink}
   */
  toPublic(link) {
    return {
      code: link.code,
      shortUrl: `${this.baseUrl}/${link.code}`,
      url: link.url,
      custom: link.custom,
      createdAt: /** @type {string} */ (iso(link.createdAt)),
      updatedAt: /** @type {string} */ (iso(link.updatedAt)),
      expiresAt: iso(link.expiresAt),
      maxClicks: link.maxClicks,
      clicks: link.clicks,
      lastClickAt: iso(link.lastClickAt),
      hasPassword: link.passwordHash !== null,
      enabled: link.enabled,
      tags: [...link.tags],
      redirectType: link.redirectType,
      status: linkStatus(link, this.clock.now()),
    };
  }

  /**
   * Ask the generator for a code that is neither taken nor reserved.
   * @returns {string}
   */
  allocateCode() {
    for (let attempt = 0; attempt < this.maxCodeAttempts; attempt++) {
      const code = this.generator.next(attempt);
      if (!isReservedWord(code, this.reservedWords) && !this.store.hasLink(code)) return code;
    }
    throw new AppError('Could not allocate a free short code; try again or use a longer code length', {
      code: 'code_space_exhausted',
      status: 503,
    });
  }

  /**
   * Create a link from untrusted input.
   * @param {unknown} rawInput
   * @returns {Promise<PublicLink>}
   */
  async createLink(rawInput) {
    const input = assertPlainObject(rawInput, 'Link');
    rejectUnknownFields(input, CREATE_FIELDS);
    const now = this.clock.now();

    const { url } = normalizeUrl(input.url, this.urlPolicy);
    const custom = input.alias !== undefined && input.alias !== null;
    const alias = custom ? validateAlias(input.alias, { reserved: this.reservedWords }) : null;
    const expiresAt = parseExpiry(input, now) ?? null;
    const maxClicks = input.maxClicks === undefined ? null : parseMaxClicks(input.maxClicks);
    const password = input.password === undefined ? null : parsePassword(input.password);
    const enabled = input.enabled === undefined ? true : parseEnabled(input.enabled);
    const tags = input.tags === undefined ? [] : parseTags(input.tags);
    const redirectType =
      input.redirectType === undefined ? this.defaultRedirectType : parseRedirectType(input.redirectType);

    if (alias !== null && this.store.hasLink(alias)) {
      throw new ConflictError(`Alias "${alias}" is already in use`, { code: 'alias_taken' });
    }
    const passwordHash = password === null ? null : await hashPassword(password, this.passwordCost);
    // Hashing is asynchronous, so another request may have claimed the alias meanwhile.
    if (alias !== null && this.store.hasLink(alias)) {
      throw new ConflictError(`Alias "${alias}" is already in use`, { code: 'alias_taken' });
    }

    /** @type {Link} */
    const link = {
      code: alias ?? this.allocateCode(),
      url,
      custom,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      maxClicks,
      clicks: 0,
      lastClickAt: null,
      passwordHash,
      enabled,
      tags,
      redirectType,
    };
    this.store.insertLink(link);
    return this.toPublic(link);
  }

  /**
   * @param {string} code
   * @returns {Link}
   */
  requireLink(code) {
    const link = this.store.getLink(code);
    if (!link) throw new NotFoundError(`No link with code "${code}"`, { code: 'link_not_found' });
    return link;
  }

  /**
   * @param {string} code
   * @returns {PublicLink}
   */
  getLink(code) {
    return this.toPublic(this.requireLink(code));
  }

  /**
   * Apply a partial update. `null` clears expiresAt, maxClicks and password.
   * @param {string} code
   * @param {unknown} rawPatch
   * @returns {Promise<PublicLink>}
   */
  async updateLink(code, rawPatch) {
    const input = assertPlainObject(rawPatch, 'Patch');
    rejectUnknownFields(input, UPDATE_FIELDS);
    this.requireLink(code);
    const now = this.clock.now();

    /** @type {Partial<Link>} */
    const patch = {};
    if (input.url !== undefined) patch.url = normalizeUrl(input.url, this.urlPolicy).url;
    const expiresAt = parseExpiry(input, now);
    if (expiresAt !== undefined) patch.expiresAt = expiresAt;
    if (input.maxClicks !== undefined) patch.maxClicks = parseMaxClicks(input.maxClicks);
    if (input.enabled !== undefined) patch.enabled = parseEnabled(input.enabled);
    if (input.tags !== undefined) patch.tags = parseTags(input.tags);
    if (input.redirectType !== undefined) patch.redirectType = parseRedirectType(input.redirectType);
    if (input.password !== undefined) {
      const password = parsePassword(input.password);
      patch.passwordHash = password === null ? null : await hashPassword(password, this.passwordCost);
    }
    if (Object.keys(patch).length === 0) return this.getLink(code);

    patch.updatedAt = now;
    // The link may have been deleted while the password was being hashed.
    this.requireLink(code);
    return this.toPublic(this.store.updateLink(code, patch));
  }

  /**
   * @param {string} code
   */
  deleteLink(code) {
    if (!this.store.deleteLink(code)) {
      throw new NotFoundError(`No link with code "${code}"`, { code: 'link_not_found' });
    }
  }
}
