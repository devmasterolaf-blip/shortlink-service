import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock, systemClock, utcDay } from '../src/clock.js';

test('systemClock follows the wall clock', () => {
  const before = Date.now();
  const now = systemClock.now();
  assert.ok(now >= before && now <= Date.now());
});

test('ManualClock only moves when told to', () => {
  const clock = new ManualClock('2026-03-01T00:00:00Z');
  const start = clock.now();
  clock.advance(1500);
  assert.equal(clock.now(), start + 1500);
  clock.set(new Date(5));
  assert.equal(clock.now(), 5);
  assert.throws(() => clock.advance(-1), RangeError);
  assert.throws(() => new ManualClock('not a date'), RangeError);
});

test('utcDay formats the UTC calendar day', () => {
  assert.equal(utcDay(Date.parse('2026-03-01T23:59:59.999Z')), '2026-03-01');
  assert.equal(utcDay(Date.parse('2026-03-02T00:00:00+02:00')), '2026-03-01');
});
