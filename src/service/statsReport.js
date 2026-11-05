/**
 * Turn the stored click aggregates of a link into the report returned by
 * the API and the CLI.
 */

import { ValidationError } from '../errors.js';

/**
 * @typedef {object} StatsReport
 * @property {string} code
 * @property {number} totalClicks all-time clicks, independent of the date range
 * @property {number} clicksInRange clicks on the listed days
 * @property {number} uniqueVisitors sum of daily unique visitors on the listed days
 * @property {string | null} lastClickAt ISO-8601
 * @property {Array<{ date: string, clicks: number, uniqueVisitors: number }>} days ascending, only days with clicks
 * @property {Array<{ referrer: string, clicks: number }>} referrers most clicks first
 * @property {Array<{ family: string, clicks: number }>} userAgents most clicks first
 */

/**
 * @param {string | undefined} value
 * @param {string} field
 * @returns {string | undefined}
 */
function parseDay(value, field) {
  if (value === undefined) return undefined;
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid) throw new ValidationError(`${field} must be a calendar date formatted YYYY-MM-DD`, { field });
  return value;
}

/**
 * @param {Record<string, number>} histogram
 * @returns {Array<[string, number]>} entries ordered by count (descending), then by label
 */
function ranked(histogram) {
  return Object.entries(histogram).sort(([nameA, a], [nameB, b]) => b - a || (nameA < nameB ? -1 : 1));
}

/**
 * @param {import('../storage/memoryStore.js').Link} link
 * @param {import('../analytics/stats.js').SerializedStats} stats
 * @param {Record<string, string | undefined>} [rawQuery] optional inclusive `from` / `to` days
 * @returns {StatsReport}
 */
export function buildStatsReport(link, stats, rawQuery = {}) {
  const unknown = Object.keys(rawQuery).filter((key) => key !== 'from' && key !== 'to');
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, {
      code: 'unknown_field',
      details: { fields: unknown, allowed: ['from', 'to'] },
    });
  }
  const from = parseDay(rawQuery.from, 'from');
  const to = parseDay(rawQuery.to, 'to');
  if (from !== undefined && to !== undefined && from > to) {
    throw new ValidationError('from must not be after to', { field: 'from' });
  }

  const days = Object.entries(stats.days)
    .filter(([date]) => (from === undefined || date >= from) && (to === undefined || date <= to))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, bucket]) => ({ date, clicks: bucket.clicks, uniqueVisitors: bucket.visitors.length }));

  return {
    code: link.code,
    totalClicks: stats.total,
    clicksInRange: days.reduce((sum, day) => sum + day.clicks, 0),
    uniqueVisitors: days.reduce((sum, day) => sum + day.uniqueVisitors, 0),
    lastClickAt: link.lastClickAt === null ? null : new Date(link.lastClickAt).toISOString(),
    days,
    referrers: ranked(stats.referrers).map(([referrer, clicks]) => ({ referrer, clicks })),
    userAgents: ranked(stats.userAgents).map(([family, clicks]) => ({ family, clicks })),
  };
}
