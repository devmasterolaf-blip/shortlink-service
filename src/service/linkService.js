/**
 * Service layer: every business rule about links lives here. It knows
 * nothing about HTTP and talks to storage only through the `LinkStore`
 * contract, so the API, the CLI and the importer all share one behaviour.
 */

import {
  AppError,
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
  UnauthorizedError,
} from '../errors.js';
import { systemClock } from '../clock.js';
import { DEFAULT_RESERVED_WORDS, isReservedWord, validateAlias } from '../codes/alias.js';
import { normalizeUrl } from '../url/validate.js';
import { DEFAULT_SCRYPT_COST, hashPassword, verifyPassword } from '../security/password.js';
import { referrerSource, userAgentFamily } from '../analytics/classify.js';
import { VisitorHasher } from '../analytics/visitors.js';
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
import { parseListQuery, runListQuery } from './listQuery.js';
import { linkStatus } from './linkStatus.js';
import { buildStatsReport } from './statsReport.js';

/**
 * @typedef {import('../storage/memoryStore.js').Link} Link
 * @typedef {import('../storage/memoryStore.js').LinkStore} LinkStore
 * @typedef {import('./linkStatus.js').LinkStatus} LinkStatus
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
 * @property {VisitorHasher} [visitorHasher]
 * @property {number} [permanentMaxAge] seconds a 301 may be cached (default one day)
 */

/**
 * What the redirect endpoint knows about the incoming request.
 * @typedef {object} ResolveRequest
 * @property {string} [password] password supplied by the visitor
 * @property {string} [ip]
 * @property {string} [referrer] raw `Referer` header
 * @property {string} [userAgent] raw `User-Agent` header
 * @property {boolean} [countClick] false to resolve without recording a click (default true)
 */

/**
 * @typedef {object} Resolution
 * @property {string} code
 * @property {string} url destination
 * @property {301 | 302 | 307} status
 * @property {string} cacheControl value for the `Cache-Control` response header
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
 * Cache policy of a redirect response.
 *
 * Only an unconditional permanent redirect may be cached by shared caches.
 * A permanent link that expires may be cached privately until it does, and
 * anything that depends on per-request state (password, click budget) or
 * is temporary must not be cached at all, so every visit reaches the
 * service.
 * @param {Link} link
 * @param {number} now
 * @param {number} permanentMaxAge seconds
 * @returns {string}
 */
export function cacheControlFor(link, now, permanentMaxAge) {
  if (link.redirectType !== 301 || link.passwordHash !== null || link.maxClicks !== null) return 'no-store';
  if (link.expiresAt !== null) {
    const secondsLeft = Math.max(0, Math.floor((link.expiresAt - now) / 1000));
    return `private, max-age=${Math.min(permanentMaxAge, secondsLeft)}`;
  }
  return `public, max-age=${permanentMaxAge}`;
}

/**
 * @param {number | null} ms
 * @returns {string | null}
 */
function iso(ms) {
  return ms === null ? null : new Date(ms).toISOString();
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
    this.visitorHasher = options.visitorHasher ?? new VisitorHasher();
    this.permanentMaxAge = options.permanentMaxAge ?? 86_400;
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
   * List links with filtering, sorting and pagination.
   * @param {Record<string, string | undefined>} [rawQuery] see `parseListQuery`
   * @returns {import('./listQuery.js').Page<PublicLink>}
   */
  listLinks(rawQuery = {}) {
    const query = parseListQuery(rawQuery);
    const page = runListQuery(this.store.listLinks(), query, this.clock.now());
    return { ...page, items: page.items.map((link) => this.toPublic(link)) };
  }

  /**
   * @param {string} code
   */
  deleteLink(code) {
    if (!this.store.deleteLink(code)) {
      throw new NotFoundError(`No link with code "${code}"`, { code: 'link_not_found' });
    }
  }

  /**
   * Throw unless `link` can currently be followed.
   * @param {Link | undefined} link
   * @param {string} code
   * @returns {Link}
   */
  assertFollowable(link, code) {
    // A disabled link is indistinguishable from one that never existed.
    if (!link || !link.enabled) {
      throw new NotFoundError(`No link with code "${code}"`, { code: 'link_not_found' });
    }
    const status = linkStatus(link, this.clock.now());
    if (status === 'expired') throw new GoneError('This link has expired', { code: 'link_expired' });
    if (status === 'exhausted') {
      throw new GoneError('This link has reached its click limit', { code: 'link_exhausted' });
    }
    return link;
  }

  /**
   * Resolve a short code for a visitor: enforce the link's rules, record
   * the click and say where to redirect.
   * @param {string} code
   * @param {ResolveRequest} [request]
   * @returns {Promise<Resolution>}
   */
  async resolve(code, request = {}) {
    let link = this.assertFollowable(this.store.getLink(code), code);
    if (link.passwordHash !== null) {
      if (request.password === undefined || request.password === '') {
        throw new UnauthorizedError('This link is password protected', { code: 'password_required' });
      }
      if (!(await verifyPassword(request.password, link.passwordHash))) {
        throw new ForbiddenError('Incorrect password', { code: 'password_incorrect' });
      }
      // Verification is asynchronous: re-check so that concurrent visitors
      // cannot overshoot the click budget or use a link changed meanwhile.
      link = this.assertFollowable(this.store.getLink(code), code);
    }

    const now = this.clock.now();
    if (request.countClick !== false) {
      this.store.recordClick({
        code,
        at: now,
        referrer: referrerSource(request.referrer),
        userAgent: userAgentFamily(request.userAgent),
        visitor: this.visitorHasher.hash(request.ip ?? '', now),
      });
    }
    return {
      code,
      url: link.url,
      status: link.redirectType,
      cacheControl: cacheControlFor(link, now, this.permanentMaxAge),
    };
  }

  /**
   * @param {string} code
   * @param {Record<string, string | undefined>} [rawQuery] optional `from` / `to` days (YYYY-MM-DD)
   * @returns {import('./statsReport.js').StatsReport}
   */
  getStats(code, rawQuery = {}) {
    const link = this.requireLink(code);
    const stats = this.store.getStats(code);
    if (!stats) throw new NotFoundError(`No link with code "${code}"`, { code: 'link_not_found' });
    return buildStatsReport(link, stats, rawQuery);
  }
}
