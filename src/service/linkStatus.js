/**
 * Derived link state shared by the service, the list query and the
 * redirect logic.
 */

/**
 * @typedef {import('../storage/memoryStore.js').Link} Link
 * @typedef {'active' | 'disabled' | 'expired' | 'exhausted'} LinkStatus
 */

/**
 * Precedence: a disabled link is "disabled" even when it is also expired,
 * and an expired link is "expired" even when its click budget is used up.
 * @param {Link} link
 * @param {number} now
 * @returns {LinkStatus}
 */
export function linkStatus(link, now) {
  if (!link.enabled) return 'disabled';
  if (link.expiresAt !== null && link.expiresAt <= now) return 'expired';
  if (link.maxClicks !== null && link.clicks >= link.maxClicks) return 'exhausted';
  return 'active';
}
