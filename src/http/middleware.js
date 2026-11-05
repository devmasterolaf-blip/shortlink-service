/**
 * Cross-cutting HTTP middleware: error handling, authentication and rate
 * limiting.
 */

import {
  ForbiddenError,
  MethodNotAllowedError,
  PayloadTooLargeError,
  RateLimitedError,
  UnauthorizedError,
  toErrorResponse,
} from '../errors.js';
import { hasScope } from '../security/apiKeys.js';
import { header, sendJson } from './context.js';

/**
 * @typedef {import('./context.js').RequestContext} RequestContext
 * @typedef {import('./router.js').Middleware<RequestContext>} Middleware
 */

/**
 * @typedef {object} Logger
 * @property {(message: string, fields?: Record<string, unknown>) => void} info
 * @property {(message: string, fields?: Record<string, unknown>) => void} error
 */

/** @type {Logger} */
export const silentLogger = Object.freeze({ info() {}, error() {} });

/**
 * Outermost middleware: turns anything thrown further down into the JSON
 * error envelope and logs unexpected failures.
 * @param {Logger} logger
 * @returns {Middleware}
 */
export function errorBoundary(logger) {
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      const { status, body } = toErrorResponse(err, ctx.requestId);
      if (status >= 500) {
        logger.error('request failed', {
          requestId: ctx.requestId,
          method: ctx.method,
          path: ctx.path,
          error: err instanceof Error ? err.stack ?? err.message : String(err),
        });
      }
      if (ctx.res.headersSent) {
        // Too late for an error response; drop the connection so the client notices.
        ctx.res.destroy();
        return;
      }
      /** @type {Record<string, string | number>} */
      const headers = { 'Cache-Control': 'no-store' };
      if (err instanceof MethodNotAllowedError) headers.Allow = err.allowed.join(', ');
      if (err instanceof RateLimitedError) headers['Retry-After'] = err.retryAfterSeconds;
      if (err instanceof UnauthorizedError && err.code !== 'password_required') {
        headers['WWW-Authenticate'] = 'Bearer realm="shortlink-service"';
      }
      // The unread remainder of an oversized body would otherwise be parsed as the next request.
      if (err instanceof PayloadTooLargeError) headers.Connection = 'close';
      sendJson(ctx.res, status, body, headers);
    }
  };
}

/**
 * Echo the request id and log one line per request.
 * @param {Logger} logger
 * @param {import('../clock.js').Clock} clock
 * @returns {Middleware}
 */
export function requestLog(logger, clock) {
  return async (ctx, next) => {
    const startedAt = clock.now();
    ctx.res.setHeader('X-Request-Id', ctx.requestId);
    try {
      await next();
    } finally {
      logger.info('request', {
        requestId: ctx.requestId,
        method: ctx.method,
        path: ctx.path,
        status: ctx.res.statusCode,
        durationMs: clock.now() - startedAt,
        apiKey: ctx.apiKey?.name,
      });
    }
  };
}

/**
 * Extract the API key from `Authorization: Bearer <key>` or `X-API-Key`.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | undefined}
 */
export function presentedApiKey(req) {
  const authorization = header(req, 'authorization');
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    return match ? match[1] : undefined;
  }
  return header(req, 'x-api-key');
}

/**
 * Require a valid API key that carries `scope`.
 * @param {import('../security/apiKeys.js').ApiKeyRegistry} registry
 * @param {string} scope
 * @returns {Middleware}
 */
export function authenticate(registry, scope) {
  return async (ctx, next) => {
    const presented = presentedApiKey(ctx.req);
    if (presented === undefined) {
      throw new UnauthorizedError('An API key is required (Authorization: Bearer <key> or X-API-Key)', {
        code: 'api_key_required',
      });
    }
    const key = registry.authenticate(presented);
    if (!key) throw new UnauthorizedError('The API key is not valid', { code: 'api_key_invalid' });
    ctx.apiKey = key;
    if (!hasScope(key, scope)) {
      throw new ForbiddenError(`This API key lacks the "${scope}" scope`, {
        code: 'insufficient_scope',
        details: { required: scope },
      });
    }
    await next();
  };
}

/**
 * Per-key rate limit; must run after {@link authenticate}.
 * @param {import('../security/rateLimiter.js').TokenBucketLimiter} limiter
 * @returns {Middleware}
 */
export function rateLimit(limiter) {
  return async (ctx, next) => {
    const identity = ctx.apiKey ? `key:${ctx.apiKey.name}` : `ip:${ctx.ip}`;
    const decision = limiter.take(identity);
    ctx.res.setHeader('X-RateLimit-Limit', decision.limit);
    ctx.res.setHeader('X-RateLimit-Remaining', decision.remaining);
    if (!decision.allowed) throw new RateLimitedError(Math.ceil(decision.retryAfterMs / 1000));
    await next();
  };
}
