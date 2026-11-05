/**
 * Per-request context and response helpers used by the HTTP layer.
 */

import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors.js';

/**
 * @typedef {object} RequestContext
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {string} method upper-case HTTP method
 * @property {string} path URL path without the query string, still percent-encoded
 * @property {URLSearchParams} query
 * @property {Record<string, string>} params route parameters, filled in by the router
 * @property {string} requestId
 * @property {string} ip client address
 * @property {import('../security/apiKeys.js').ApiKey | null} apiKey set by the authentication middleware
 */

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name lower-case header name
 * @returns {string | undefined} the header value; the first one when it was sent several times
 */
export function header(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Address of the client. Behind a reverse proxy (`trustProxy`), the last
 * entry of `X-Forwarded-For` is used: it is the one appended by the proxy
 * directly in front of this service, whereas earlier entries are supplied
 * by the client and can be forged.
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 * @returns {string}
 */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const list = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (list.length > 0) return list[list.length - 1];
  }
  return req.socket.remoteAddress ?? '';
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ trustProxy?: boolean }} [options]
 * @returns {RequestContext}
 */
export function createContext(req, res, options = {}) {
  const rawUrl = req.url ?? '/';
  const queryStart = rawUrl.indexOf('?');
  const path = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const supplied = header(req, 'x-request-id');
  return {
    req,
    res,
    method: (req.method ?? 'GET').toUpperCase(),
    path,
    query: new URLSearchParams(queryStart === -1 ? '' : rawUrl.slice(queryStart + 1)),
    params: {},
    requestId: supplied !== undefined && /^[\w.-]{1,64}$/.test(supplied) ? supplied : randomUUID(),
    ip: clientIp(req, options.trustProxy ?? false),
    apiKey: null,
  };
}

/**
 * Flatten a query string into an object, refusing repeated parameters so
 * that `?page=1&page=2` is an error instead of a silent pick.
 * @param {URLSearchParams} query
 * @returns {Record<string, string>}
 */
export function queryToObject(query) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const [name, value] of query) {
    if (Object.hasOwn(result, name)) {
      throw new ValidationError(`Query parameter "${name}" was given more than once`, {
        code: 'duplicate_parameter',
        details: { parameter: name },
      });
    }
    result[name] = value;
  }
  return result;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string | number>} [headers]
 */
export function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 * @param {Record<string, string | number>} [headers]
 */
export function sendText(res, status, text, headers = {}) {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}
