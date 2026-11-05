/**
 * Privacy-preserving visitor identifiers.
 *
 * The service never stores IP addresses. A visitor is represented by a
 * keyed hash of the address, and the key ("salt") rotates every UTC day:
 *
 *   salt(day)  = HMAC-SHA256(secret, "visitor-salt:" + day)
 *   visitor    = HMAC-SHA256(salt(day), ip), truncated to 16 hex characters
 *
 * The same address therefore yields the same identifier within a day (so
 * unique visitors can be counted) and an unrelated one on the next day (so
 * visits cannot be linked across days).
 */

import { createHmac, randomBytes } from 'node:crypto';
import { utcDay } from '../clock.js';

export class VisitorHasher {
  /** @param {{ secret?: string | Buffer }} [options] a random secret is generated when omitted */
  constructor(options = {}) {
    /** @type {string | Buffer} */
    this.secret = options.secret ?? randomBytes(32);
    /** @type {{ day: string, salt: Buffer } | null} */
    this.cached = null;
  }

  /**
   * @param {string} day `YYYY-MM-DD`
   * @returns {Buffer}
   */
  saltFor(day) {
    if (this.cached?.day !== day) {
      const salt = createHmac('sha256', this.secret).update(`visitor-salt:${day}`).digest();
      this.cached = { day, salt };
    }
    return this.cached.salt;
  }

  /**
   * @param {string} ip client address as reported by the socket or proxy
   * @param {number} at epoch milliseconds of the visit
   * @returns {string}
   */
  hash(ip, at) {
    const salt = this.saltFor(utcDay(at));
    return createHmac('sha256', salt).update(normalizeIp(ip)).digest('hex').slice(0, 16);
  }
}

/**
 * Canonical text form used for hashing, so one client is not counted twice
 * when it shows up as both `1.2.3.4` and `::ffff:1.2.3.4`.
 * @param {string} ip
 * @returns {string}
 */
export function normalizeIp(ip) {
  const text = String(ip ?? '').trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  return mapped ? mapped[1] : text;
}
