/**
 * Strict validation and normalisation of destination URLs.
 *
 * Parsing is delegated to the WHATWG `URL` class, which already lower-cases
 * the scheme and host, converts internationalised names to punycode, drops
 * default ports, resolves dot segments and canonicalises numeric IPv4 forms
 * such as `http://2130706433/` or `http://0x7f.1/`. The checks below run on
 * that canonical form so obfuscated spellings cannot slip through.
 */

import { domainToUnicode } from 'node:url';
import { ValidationError } from '../errors.js';

/**
 * @typedef {object} UrlPolicy
 * @property {readonly string[]} [allowedSchemes] schemes without the colon (default http, https)
 * @property {number} [maxLength] maximum length of the input and of the normalised URL
 * @property {boolean} [blockPrivateHosts] reject loopback, private and other non-public hosts
 * @property {boolean} [allowCredentials] allow `user:pass@` in the URL (default false)
 * @property {readonly string[]} [selfHosts] `host[:port]` values of this service; links to them are rejected
 */

/**
 * @typedef {object} NormalizedUrl
 * @property {string} url canonical absolute URL
 * @property {string} host ASCII (punycode) host name without port
 * @property {string} unicodeHost host name decoded for display
 */

export const DEFAULT_ALLOWED_SCHEMES = Object.freeze(['http', 'https']);
export const DEFAULT_MAX_URL_LENGTH = 2048;

/**
 * @typedef {'public' | 'loopback' | 'private' | 'link-local' | 'unspecified' | 'reserved'} HostClass
 */

/**
 * @param {string} message
 * @param {string} code
 */
function invalid(message, code) {
  return new ValidationError(message, { field: 'url', code });
}

/**
 * Validate `input` against `policy` and return its canonical form.
 * @param {unknown} input
 * @param {UrlPolicy} [policy]
 * @returns {NormalizedUrl}
 */
export function normalizeUrl(input, policy = {}) {
  const allowedSchemes = policy.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
  const maxLength = policy.maxLength ?? DEFAULT_MAX_URL_LENGTH;

  if (typeof input !== 'string') throw invalid('url must be a string', 'url_invalid');
  const text = input.trim();
  if (text === '') throw invalid('url must not be empty', 'url_invalid');
  if (text.length > maxLength) {
    throw invalid(`url is longer than ${maxLength} characters`, 'url_too_long');
  }
  if (/[\u0000- \u007f]/.test(text)) {
    throw invalid('url must not contain whitespace or control characters', 'url_invalid');
  }

  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw invalid('url is not a valid absolute URL', 'url_invalid');
  }

  const scheme = parsed.protocol.slice(0, -1);
  if (!allowedSchemes.includes(scheme)) {
    throw invalid(
      `url scheme "${scheme}" is not allowed (allowed: ${allowedSchemes.join(', ')})`,
      'url_scheme_not_allowed',
    );
  }
  if (parsed.hostname === '') throw invalid('url must include a host', 'url_invalid');
  if (!policy.allowCredentials && (parsed.username !== '' || parsed.password !== '')) {
    throw invalid('url must not contain credentials', 'url_credentials_not_allowed');
  }

  const host = stripTrailingDot(parsed.hostname);
  if (policy.blockPrivateHosts) {
    const hostClass = classifyHost(host);
    if (hostClass !== 'public') {
      throw invalid(`url host is not publicly routable (${hostClass})`, 'url_host_not_allowed');
    }
  }
  if (policy.selfHosts && policy.selfHosts.length > 0) {
    const target = hostWithPort(parsed);
    if (policy.selfHosts.some((self) => stripTrailingDot(self.toLowerCase()) === target)) {
      throw invalid('url points at this service and would create a redirect loop', 'url_self_reference');
    }
  }

  const url = parsed.href;
  if (url.length > maxLength) {
    throw invalid(`normalised url is longer than ${maxLength} characters`, 'url_too_long');
  }
  return { url, host, unicodeHost: domainToUnicode(host) || host };
}

/**
 * `host[:port]` of a base URL in the form expected by `UrlPolicy.selfHosts`.
 * @param {string} baseUrl
 * @returns {string}
 */
export function selfHostOf(baseUrl) {
  return hostWithPort(new URL(baseUrl));
}

/**
 * @param {URL} parsed
 * @returns {string}
 */
function hostWithPort(parsed) {
  const host = stripTrailingDot(parsed.hostname);
  return parsed.port === '' ? host : `${host}:${parsed.port}`;
}

/**
 * @param {string} host
 * @returns {string}
 */
function stripTrailingDot(host) {
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/**
 * Classify a canonical host name (as produced by `URL.hostname`).
 * @param {string} hostname
 * @returns {HostClass}
 */
export function classifyHost(hostname) {
  const host = stripTrailingDot(hostname.toLowerCase());
  if (host.startsWith('[') && host.endsWith(']')) return classifyIPv6(host.slice(1, -1));
  const v4 = parseIPv4(host);
  if (v4) return classifyIPv4(v4);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (host.endsWith('.local') || host.endsWith('.internal')) return 'private';
  // A single-label name ("intranet", "router") only resolves inside a local network.
  if (!host.includes('.')) return 'private';
  return 'public';
}

/**
 * @param {string} host
 * @returns {number[] | null} four octets, or null when `host` is not dotted-decimal IPv4
 */
function parseIPv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/**
 * @param {number[]} octets
 * @returns {HostClass}
 */
function classifyIPv4([a, b]) {
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a >= 224) return 'reserved';
  return 'public';
}

/**
 * Expand a textual IPv6 address (hex groups only, as serialised by `URL`)
 * into its eight 16-bit groups.
 * @param {string} text
 * @returns {number[] | null}
 */
function parseIPv6(text) {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (/** @type {string} */ part) =>
    part === '' ? [] : part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  const groups =
    halves.length === 2
      ? [...head, ...new Array(Math.max(0, 8 - head.length - tail.length)).fill(0), ...tail]
      : head;
  if (groups.length !== 8 || groups.some((group) => Number.isNaN(group))) return null;
  return groups;
}

/**
 * @param {string} text address without brackets
 * @returns {HostClass}
 */
function classifyIPv6(text) {
  const groups = parseIPv6(text);
  if (!groups) return 'reserved';
  const embeddedV4 = () => classifyIPv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  const leadingZeros = groups.slice(0, 5).every((group) => group === 0);
  if (leadingZeros && groups[5] === 0 && groups[6] === 0) {
    if (groups[7] === 0) return 'unspecified';
    if (groups[7] === 1) return 'loopback';
  }
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) inherit the IPv4 class.
  if (leadingZeros && groups[5] === 0xffff) return embeddedV4();
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return embeddedV4();
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return 'private';
  if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((groups[0] & 0xff00) === 0xff00) return 'reserved';
  return 'public';
}
