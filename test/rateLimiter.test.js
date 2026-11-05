import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucketLimiter } from '../src/security/rateLimiter.js';
import { ManualClock } from '../src/clock.js';

test('allows a burst up to the capacity, then rejects with a retry hint', () => {
  const clock = new ManualClock(0);
  const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 2, clock });
  assert.deepEqual(limiter.take('k'), { allowed: true, limit: 3, remaining: 2, retryAfterMs: 0 });
  assert.equal(limiter.take('k').remaining, 1);
  assert.equal(limiter.take('k').remaining, 0);
  assert.deepEqual(limiter.take('k'), { allowed: false, limit: 3, remaining: 0, retryAfterMs: 500 });
});

test('refills continuously and never above the capacity', () => {
  const clock = new ManualClock(0);
  const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1, clock });
  limiter.take('k');
  limiter.take('k');
  clock.advance(400);
  assert.deepEqual(limiter.take('k'), { allowed: false, limit: 2, remaining: 0, retryAfterMs: 600 });
  clock.advance(600);
  assert.equal(limiter.take('k').allowed, true);
  clock.advance(60_000);
  assert.equal(limiter.take('k').remaining, 1);
});

test('a rejected request does not consume tokens', () => {
  const clock = new ManualClock(0);
  const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, clock });
  limiter.take('k');
  for (let i = 0; i < 10; i++) assert.equal(limiter.take('k').allowed, false);
  clock.advance(1000);
  assert.equal(limiter.take('k').allowed, true);
});

test('identities have independent buckets', () => {
  const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, clock: new ManualClock(0) });
  assert.equal(limiter.take('a').allowed, true);
  assert.equal(limiter.take('a').allowed, false);
  assert.equal(limiter.take('b').allowed, true);
});

test('supports weighted requests', () => {
  const clock = new ManualClock(0);
  const limiter = new TokenBucketLimiter({ capacity: 10, refillPerSecond: 5, clock });
  assert.equal(limiter.take('k', 8).remaining, 2);
  assert.deepEqual(limiter.take('k', 4), { allowed: false, limit: 10, remaining: 2, retryAfterMs: 400 });
  assert.throws(() => limiter.take('k', 11), RangeError);
  assert.throws(() => limiter.take('k', 0), RangeError);
});

test('a clock that jumps backwards neither refills nor drains', () => {
  const clock = new ManualClock(10_000);
  const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1, clock });
  limiter.take('k');
  clock.set(5_000);
  assert.equal(limiter.take('k').remaining, 0);
  assert.equal(limiter.take('k').allowed, false);
});

test('sweep drops only buckets that are full again', () => {
  const clock = new ManualClock(0);
  const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1, clock });
  limiter.take('idle');
  clock.advance(5_000);
  limiter.take('busy');
  assert.equal(limiter.sweep(), 1);
  assert.equal(limiter.size, 1);
  assert.equal(limiter.take('busy').remaining, 0);
});

test('maxBuckets triggers a sweep before adding a new identity', () => {
  const clock = new ManualClock(0);
  const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, clock, maxBuckets: 3 });
  for (const key of ['a', 'b', 'c']) limiter.take(key);
  clock.advance(2_000);
  limiter.take('d');
  assert.equal(limiter.size, 1);
});

test('validates construction parameters', () => {
  assert.throws(() => new TokenBucketLimiter({ capacity: 0, refillPerSecond: 1 }), RangeError);
  assert.throws(() => new TokenBucketLimiter({ capacity: 5, refillPerSecond: 0 }), RangeError);
});
