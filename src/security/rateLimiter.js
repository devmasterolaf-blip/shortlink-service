/**
 * Token-bucket rate limiter keyed by an arbitrary identity (an API key
 * name, an IP address, ...).
 *
 * Each identity owns a bucket of `capacity` tokens that refills
 * continuously at `refillPerSecond`. A request takes one token; when the
 * bucket is empty the limiter reports how long to wait until one token is
 * available again. Buckets are refilled lazily from the injected clock, so
 * there are no timers.
 */

import { systemClock } from '../clock.js';

/**
 * @typedef {object} RateLimitDecision
 * @property {boolean} allowed
 * @property {number} limit bucket capacity
 * @property {number} remaining whole tokens left after this decision
 * @property {number} retryAfterMs 0 when allowed, otherwise the wait until `cost` tokens are available
 */

export class TokenBucketLimiter {
  /**
   * @param {{ capacity: number, refillPerSecond: number, clock?: import('../clock.js').Clock, maxBuckets?: number }} options
   *   `maxBuckets` bounds memory: when exceeded, buckets that have fully refilled are dropped.
   */
  constructor({ capacity, refillPerSecond, clock = systemClock, maxBuckets = 10_000 }) {
    if (!Number.isFinite(capacity) || capacity < 1) throw new RangeError('capacity must be at least 1');
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new RangeError('refillPerSecond must be positive');
    }
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.clock = clock;
    this.maxBuckets = maxBuckets;
    /** @type {Map<string, { tokens: number, updatedAt: number }>} */
    this.buckets = new Map();
  }

  /**
   * @param {{ tokens: number, updatedAt: number }} bucket
   * @param {number} now
   */
  refill(bucket, now) {
    // A clock that moves backwards must not drain or over-fill the bucket.
    const elapsedMs = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (elapsedMs / 1000) * this.refillPerSecond);
    bucket.updatedAt = now;
  }

  /**
   * Try to take `cost` tokens for `key`.
   * @param {string} key
   * @param {number} [cost]
   * @returns {RateLimitDecision}
   */
  take(key, cost = 1) {
    if (!(cost > 0) || cost > this.capacity) {
      throw new RangeError(`cost must be between 0 (exclusive) and the capacity ${this.capacity}`);
    }
    const now = this.clock.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) this.sweep();
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      this.refill(bucket, now);
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, limit: this.capacity, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    const retryAfterMs = Math.ceil(((cost - bucket.tokens) / this.refillPerSecond) * 1000);
    return { allowed: false, limit: this.capacity, remaining: Math.floor(bucket.tokens), retryAfterMs };
  }

  /**
   * Drop buckets that are full again; they behave exactly like new ones.
   * @returns {number} number of buckets removed
   */
  sweep() {
    const now = this.clock.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      this.refill(bucket, now);
      if (bucket.tokens >= this.capacity) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.buckets.size;
  }
}
