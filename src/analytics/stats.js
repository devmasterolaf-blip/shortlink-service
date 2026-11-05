/**
 * Per-link click aggregates.
 *
 * Clicks are folded into small counters instead of being kept as raw events:
 * a per-day bucket (click count plus the set of visitor hashes seen that
 * day), a referrer histogram and a user-agent family histogram. Day buckets
 * older than the retention window are dropped as new days arrive.
 */

import { utcDay } from '../clock.js';

const DAY_MS = 86_400_000;

/** Bucket that absorbs referrers once the histogram is full. */
export const OTHER_REFERRER = '(other)';

/**
 * @typedef {object} ClickEvent
 * @property {string} code
 * @property {number} at epoch milliseconds
 * @property {string} referrer referrer host, or a marker such as "(direct)"
 * @property {string} userAgent user-agent family
 * @property {string} visitor salted visitor hash
 */

/**
 * @typedef {object} LinkStats
 * @property {number} total all-time click count
 * @property {Map<string, { clicks: number, visitors: Set<string> }>} days keyed by `YYYY-MM-DD`
 * @property {Map<string, number>} referrers
 * @property {Map<string, number>} userAgents
 */

/**
 * JSON form of {@link LinkStats}, used in journals and snapshots.
 * @typedef {object} SerializedStats
 * @property {number} total
 * @property {Record<string, { clicks: number, visitors: string[] }>} days
 * @property {Record<string, number>} referrers
 * @property {Record<string, number>} userAgents
 */

/**
 * @typedef {object} StatsLimits
 * @property {number} [retentionDays] day buckets kept (default 90)
 * @property {number} [maxReferrers] distinct referrers tracked before "(other)" (default 50)
 */

/** @returns {LinkStats} */
export function createStats() {
  return { total: 0, days: new Map(), referrers: new Map(), userAgents: new Map() };
}

/**
 * Fold one click into `stats` (mutates it).
 * @param {LinkStats} stats
 * @param {ClickEvent} event
 * @param {StatsLimits} [limits]
 */
export function applyClick(stats, event, limits = {}) {
  const retentionDays = limits.retentionDays ?? 90;
  const maxReferrers = limits.maxReferrers ?? 50;

  stats.total += 1;

  const day = utcDay(event.at);
  let bucket = stats.days.get(day);
  if (!bucket) {
    bucket = { clicks: 0, visitors: new Set() };
    stats.days.set(day, bucket);
    const cutoff = utcDay(event.at - (retentionDays - 1) * DAY_MS);
    for (const key of stats.days.keys()) {
      if (key < cutoff) stats.days.delete(key);
    }
  }
  bucket.clicks += 1;
  bucket.visitors.add(event.visitor);

  const referrer =
    stats.referrers.has(event.referrer) || stats.referrers.size < maxReferrers
      ? event.referrer
      : OTHER_REFERRER;
  stats.referrers.set(referrer, (stats.referrers.get(referrer) ?? 0) + 1);
  stats.userAgents.set(event.userAgent, (stats.userAgents.get(event.userAgent) ?? 0) + 1);
}

/**
 * @param {LinkStats} stats
 * @returns {SerializedStats}
 */
export function serializeStats(stats) {
  /** @type {SerializedStats['days']} */
  const days = {};
  for (const [day, bucket] of [...stats.days].sort(([a], [b]) => (a < b ? -1 : 1))) {
    days[day] = { clicks: bucket.clicks, visitors: [...bucket.visitors] };
  }
  return {
    total: stats.total,
    days,
    referrers: Object.fromEntries(stats.referrers),
    userAgents: Object.fromEntries(stats.userAgents),
  };
}

/**
 * @param {SerializedStats} data
 * @returns {LinkStats}
 */
export function deserializeStats(data) {
  const stats = createStats();
  stats.total = data.total;
  for (const [day, bucket] of Object.entries(data.days ?? {})) {
    stats.days.set(day, { clicks: bucket.clicks, visitors: new Set(bucket.visitors) });
  }
  for (const [referrer, count] of Object.entries(data.referrers ?? {})) stats.referrers.set(referrer, count);
  for (const [family, count] of Object.entries(data.userAgents ?? {})) stats.userAgents.set(family, count);
  return stats;
}
