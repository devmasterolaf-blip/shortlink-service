/**
 * Storage layer.
 *
 * The service layer depends only on the {@link LinkStore} contract below.
 * `MemoryStore` keeps everything in process memory; every mutation is first
 * turned into a small journal record and then applied, which lets
 * `FileStore` persist the very same records and rebuild state by replaying
 * them.
 */

import { ConflictError, NotFoundError } from '../errors.js';
import { applyClick, createStats, deserializeStats, serializeStats } from '../analytics/stats.js';

/**
 * @typedef {object} Link
 * @property {string} code short code or custom alias (case-sensitive)
 * @property {string} url normalised destination
 * @property {boolean} custom true when the code was chosen by the caller
 * @property {number} createdAt epoch milliseconds
 * @property {number} updatedAt epoch milliseconds
 * @property {number | null} expiresAt epoch milliseconds, or null for "never"
 * @property {number | null} maxClicks click budget, or null for unlimited
 * @property {number} clicks redirects served so far
 * @property {number | null} lastClickAt
 * @property {string | null} passwordHash encoded scrypt hash, or null
 * @property {boolean} enabled
 * @property {string[]} tags
 * @property {301 | 302 | 307} redirectType
 */

/**
 * @typedef {import('../analytics/stats.js').ClickEvent} ClickEvent
 * @typedef {import('../analytics/stats.js').SerializedStats} SerializedStats
 */

/**
 * Journal records: the only way state changes.
 * @typedef {{ op: 'seq', value: number }
 *   | { op: 'put', link: Link }
 *   | { op: 'del', code: string }
 *   | ({ op: 'click' } & ClickEvent)
 *   | { op: 'stats', code: string, stats: SerializedStats }} JournalRecord
 */

/**
 * Contract between the service layer and a storage backend. All methods are
 * synchronous: reads are served from memory and writes are small appends.
 *
 * @typedef {object} LinkStore
 * @property {() => number} nextSequence allocate the next counter value (starts at 0)
 * @property {(code: string) => boolean} hasLink
 * @property {(code: string) => Link | undefined} getLink returns a copy
 * @property {(link: Link) => void} insertLink throws ConflictError when the code exists
 * @property {(code: string, patch: Partial<Link>) => Link} updateLink throws NotFoundError
 * @property {(code: string) => boolean} deleteLink true when a link was removed
 * @property {() => Link[]} listLinks copies, in insertion order
 * @property {() => number} countLinks
 * @property {(event: ClickEvent) => void} recordClick
 * @property {(code: string) => SerializedStats | undefined} getStats
 * @property {() => void} close
 */

/**
 * @param {Link} link
 * @returns {Link}
 */
function cloneLink(link) {
  return { ...link, tags: [...link.tags] };
}

/** @implements {LinkStore} */
export class MemoryStore {
  /** @param {import('../analytics/stats.js').StatsLimits} [statsLimits] */
  constructor(statsLimits = {}) {
    /** @type {Map<string, Link>} */
    this._links = new Map();
    /** @type {Map<string, import('../analytics/stats.js').LinkStats>} */
    this._stats = new Map();
    this._sequence = 0;
    this._statsLimits = statsLimits;
  }

  /**
   * Persist-then-apply hook. Subclasses override it to write the record to
   * durable storage before it takes effect.
   * @param {JournalRecord} record
   * @protected
   */
  _commit(record) {
    this._apply(record);
  }

  /**
   * Apply one journal record to the in-memory state.
   * @param {JournalRecord} record
   * @protected
   */
  _apply(record) {
    switch (record.op) {
      case 'seq':
        this._sequence = record.value;
        break;
      case 'put':
        this._links.set(record.link.code, cloneLink(record.link));
        break;
      case 'del':
        this._links.delete(record.code);
        this._stats.delete(record.code);
        break;
      case 'click': {
        const link = this._links.get(record.code);
        if (!link) break;
        link.clicks += 1;
        link.lastClickAt = record.at;
        let stats = this._stats.get(record.code);
        if (!stats) {
          stats = createStats();
          this._stats.set(record.code, stats);
        }
        applyClick(stats, record, this._statsLimits);
        break;
      }
      case 'stats':
        if (this._links.has(record.code)) this._stats.set(record.code, deserializeStats(record.stats));
        break;
      default:
        throw new TypeError(`Unknown journal record: ${JSON.stringify(record)}`);
    }
  }

  nextSequence() {
    const value = this._sequence;
    this._commit({ op: 'seq', value: value + 1 });
    return value;
  }

  /** @param {string} code */
  hasLink(code) {
    return this._links.has(code);
  }

  /** @param {string} code */
  getLink(code) {
    const link = this._links.get(code);
    return link ? cloneLink(link) : undefined;
  }

  /** @param {Link} link */
  insertLink(link) {
    if (this._links.has(link.code)) {
      throw new ConflictError(`Code "${link.code}" is already in use`, { code: 'code_taken' });
    }
    this._commit({ op: 'put', link: cloneLink(link) });
  }

  /**
   * @param {string} code
   * @param {Partial<Link>} patch
   * @returns {Link}
   */
  updateLink(code, patch) {
    const current = this._links.get(code);
    if (!current) throw new NotFoundError(`No link with code "${code}"`);
    const next = cloneLink({ ...current, ...patch, code });
    this._commit({ op: 'put', link: next });
    return cloneLink(next);
  }

  /** @param {string} code */
  deleteLink(code) {
    if (!this._links.has(code)) return false;
    this._commit({ op: 'del', code });
    return true;
  }

  listLinks() {
    return [...this._links.values()].map(cloneLink);
  }

  countLinks() {
    return this._links.size;
  }

  /** @param {ClickEvent} event */
  recordClick(event) {
    if (!this._links.has(event.code)) return;
    this._commit({
      op: 'click',
      code: event.code,
      at: event.at,
      referrer: event.referrer,
      userAgent: event.userAgent,
      visitor: event.visitor,
    });
  }

  /** @param {string} code */
  getStats(code) {
    if (!this._links.has(code)) return undefined;
    return serializeStats(this._stats.get(code) ?? createStats());
  }

  close() {}
}
