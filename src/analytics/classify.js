/**
 * Reduce raw request headers to the coarse labels kept in click statistics.
 * Nothing here stores the raw header values.
 */

export const DIRECT_REFERRER = '(direct)';
export const UNKNOWN_REFERRER = '(unknown)';

/**
 * Ordered rules: the first match wins. Order matters because most browsers
 * include the tokens of the browsers they descend from (Edge and Opera say
 * "Chrome" and "Safari", Chrome says "Safari").
 * @type {ReadonlyArray<[string, RegExp]>}
 */
const FAMILY_RULES = [
  ['Bot', /bot\b|crawler|spider|slurp|facebookexternalhit|preview/i],
  ['curl', /^curl\//i],
  ['Wget', /^wget\//i],
  ['Edge', /\bEdg(e|A|iOS)?\//],
  ['Opera', /\bOPR\/|\bOpera\b/],
  ['Firefox', /\bFirefox\/|\bFxiOS\//],
  ['Chrome', /\bChrome\/|\bCriOS\/|\bChromium\//],
  ['Safari', /\bSafari\//],
];

/**
 * @param {string | undefined} userAgent raw `User-Agent` header
 * @returns {string} family label such as "Chrome", "Bot" or "Other"
 */
export function userAgentFamily(userAgent) {
  if (typeof userAgent !== 'string' || userAgent.trim() === '') return 'Unknown';
  for (const [family, pattern] of FAMILY_RULES) {
    if (pattern.test(userAgent)) return family;
  }
  return 'Other';
}

/**
 * @param {string | undefined} referrer raw `Referer` header
 * @returns {string} lower-case referrer host, "(direct)" when absent, "(unknown)" when unparseable
 */
export function referrerSource(referrer) {
  if (typeof referrer !== 'string' || referrer.trim() === '') return DIRECT_REFERRER;
  try {
    const parsed = new URL(referrer.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return UNKNOWN_REFERRER;
    return parsed.hostname.replace(/^www\./, '') || UNKNOWN_REFERRER;
  } catch {
    return UNKNOWN_REFERRER;
  }
}
