/**
 * Clock abstraction so that every time-dependent rule (expiry, rate limits,
 * daily analytics buckets) can be tested deterministically.
 *
 * @typedef {object} Clock
 * @property {() => number} now current time in milliseconds since the Unix epoch
 */

/** @type {Clock} */
export const systemClock = Object.freeze({ now: () => Date.now() });

/** A clock that only moves when told to; intended for tests and simulations. */
export class ManualClock {
  /** @param {number | string | Date} [start] epoch milliseconds, ISO string or Date */
  constructor(start = 0) {
    this.ms = toEpochMs(start);
  }

  /** @returns {number} */
  now() {
    return this.ms;
  }

  /** @param {number} ms milliseconds to move forward (must not be negative) */
  advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError('advance() needs a non-negative number of milliseconds');
    }
    this.ms += ms;
  }

  /** @param {number | string | Date} value */
  set(value) {
    this.ms = toEpochMs(value);
  }
}

/**
 * @param {number | string | Date} value
 * @returns {number}
 */
function toEpochMs(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid time value: ${String(value)}`);
  return ms;
}

/**
 * UTC calendar day of a timestamp, formatted `YYYY-MM-DD`.
 * @param {number} ms
 * @returns {string}
 */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
