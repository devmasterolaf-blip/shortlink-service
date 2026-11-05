import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OTHER_REFERRER,
  applyClick,
  createStats,
  deserializeStats,
  serializeStats,
} from '../src/analytics/stats.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-01-10T12:00:00Z');

/** @param {Partial<import('../src/analytics/stats.js').ClickEvent>} [over] */
function click(over = {}) {
  return { code: 'abc', at: T0, referrer: '(direct)', userAgent: 'Chrome', visitor: 'v1', ...over };
}

test('counts clicks and unique visitors per UTC day', () => {
  const stats = createStats();
  applyClick(stats, click());
  applyClick(stats, click({ visitor: 'v2' }));
  applyClick(stats, click({ at: T0 + 1000 }));
  applyClick(stats, click({ at: T0 + DAY, visitor: 'v9' }));
  assert.equal(stats.total, 4);
  assert.equal(stats.days.get('2026-01-10')?.clicks, 3);
  assert.equal(stats.days.get('2026-01-10')?.visitors.size, 2);
  assert.equal(stats.days.get('2026-01-11')?.clicks, 1);
});

test('aggregates referrers and user-agent families', () => {
  const stats = createStats();
  applyClick(stats, click({ referrer: 'news.example' }));
  applyClick(stats, click({ referrer: 'news.example', userAgent: 'Firefox' }));
  applyClick(stats, click());
  assert.deepEqual(Object.fromEntries(stats.referrers), { 'news.example': 2, '(direct)': 1 });
  assert.deepEqual(Object.fromEntries(stats.userAgents), { Chrome: 2, Firefox: 1 });
});

test('drops day buckets older than the retention window but keeps the total', () => {
  const stats = createStats();
  for (let day = 0; day < 5; day++) applyClick(stats, click({ at: T0 + day * DAY }), { retentionDays: 3 });
  assert.deepEqual([...stats.days.keys()], ['2026-01-12', '2026-01-13', '2026-01-14']);
  assert.equal(stats.total, 5);
});

test('folds referrers beyond the cap into "(other)"', () => {
  const stats = createStats();
  const limits = { maxReferrers: 2 };
  applyClick(stats, click({ referrer: 'a.example' }), limits);
  applyClick(stats, click({ referrer: 'b.example' }), limits);
  applyClick(stats, click({ referrer: 'c.example' }), limits);
  applyClick(stats, click({ referrer: 'd.example' }), limits);
  applyClick(stats, click({ referrer: 'a.example' }), limits);
  assert.deepEqual(Object.fromEntries(stats.referrers), {
    'a.example': 2,
    'b.example': 1,
    [OTHER_REFERRER]: 2,
  });
});

test('serialisation round-trips and orders days', () => {
  const stats = createStats();
  applyClick(stats, click({ at: T0 + DAY, visitor: 'v2' }));
  applyClick(stats, click());
  const json = JSON.parse(JSON.stringify(serializeStats(stats)));
  assert.deepEqual(Object.keys(json.days), ['2026-01-10', '2026-01-11']);
  const restored = deserializeStats(json);
  assert.deepEqual(serializeStats(restored), serializeStats(stats));
  applyClick(restored, click({ visitor: 'v1' }));
  assert.equal(restored.days.get('2026-01-10')?.visitors.size, 1);
  assert.equal(restored.total, 3);
});
