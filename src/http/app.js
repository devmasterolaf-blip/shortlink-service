/**
 * HTTP application: wires the router, the middleware chain and the service
 * layer into a single request handler.
 */

import { systemClock } from '../clock.js';
import { UnsupportedMediaTypeError, ValidationError } from '../errors.js';
import { CONFLICT_POLICIES, exportCsv, exportJson, importLinks, parseImport } from '../io/importExport.js';
import { rejectUnknownFields } from '../service/linkInput.js';
import { mediaType, readBody, readJson } from './body.js';
import { createContext, queryToObject, sendJson, sendText } from './context.js';
import { authenticate, errorBoundary, rateLimit, requestLog, silentLogger } from './middleware.js';
import { registerRedirectRoutes } from './redirect.js';
import { Router, compose } from './router.js';

/**
 * @typedef {import('./context.js').RequestContext} RequestContext
 */

/**
 * @typedef {object} AppOptions
 * @property {import('../service/linkService.js').LinkService} service
 * @property {import('../security/apiKeys.js').ApiKeyRegistry} apiKeys
 * @property {import('../security/rateLimiter.js').TokenBucketLimiter} rateLimiter
 * @property {number} [maxBodyBytes] limit for JSON API bodies (default 16 KiB)
 * @property {number} [maxImportBytes] limit for import documents (default 5 MiB)
 * @property {boolean} [trustProxy] take the client address from X-Forwarded-For
 * @property {import('./middleware.js').Logger} [logger]
 * @property {import('../clock.js').Clock} [clock]
 */

/**
 * @param {AppOptions} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApp(options) {
  const { service, apiKeys, rateLimiter } = options;
  const maxBodyBytes = options.maxBodyBytes ?? 16 * 1024;
  const maxImportBytes = options.maxImportBytes ?? 5 * 1024 * 1024;
  const trustProxy = options.trustProxy ?? false;
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? systemClock;
  const startedAt = clock.now();

  /** @type {Router<RequestContext>} */
  const router = new Router();
  /** Authentication then rate limiting, for a route that needs `scope`. */
  const guard = (/** @type {string} */ scope) => [authenticate(apiKeys, scope), rateLimit(rateLimiter)];

  router.get('/healthz', (ctx) => {
    sendJson(ctx.res, 200, {
      status: 'ok',
      links: service.store.countLinks(),
      uptimeSeconds: Math.floor((clock.now() - startedAt) / 1000),
    }, { 'Cache-Control': 'no-store' });
  });

  router.post('/api/links', ...guard('links:write'), async (ctx) => {
    const link = await service.createLink(await readJson(ctx.req, maxBodyBytes));
    sendJson(ctx.res, 201, link, { Location: `/api/links/${encodeURIComponent(link.code)}` });
  });

  router.get('/api/links', ...guard('links:read'), (ctx) => {
    sendJson(ctx.res, 200, service.listLinks(queryToObject(ctx.query)));
  });

  router.get('/api/links/:code', ...guard('links:read'), (ctx) => {
    sendJson(ctx.res, 200, service.getLink(ctx.params.code));
  });

  router.patch('/api/links/:code', ...guard('links:write'), async (ctx) => {
    const patch = await readJson(ctx.req, maxBodyBytes);
    sendJson(ctx.res, 200, await service.updateLink(ctx.params.code, patch));
  });

  router.delete('/api/links/:code', ...guard('links:write'), (ctx) => {
    service.deleteLink(ctx.params.code);
    ctx.res.writeHead(204);
    ctx.res.end();
  });

  router.get('/api/links/:code/stats', ...guard('stats:read'), (ctx) => {
    sendJson(ctx.res, 200, service.getStats(ctx.params.code, queryToObject(ctx.query)));
  });

  router.get('/api/export', ...guard('admin'), (ctx) => {
    const query = queryToObject(ctx.query);
    rejectUnknownFields(query, ['format']);
    const format = query.format ?? 'json';
    if (format === 'json') {
      sendText(ctx.res, 200, exportJson(service.store, clock.now()), {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="links.json"',
        'Cache-Control': 'no-store',
      });
    } else if (format === 'csv') {
      sendText(ctx.res, 200, exportCsv(service.store), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="links.csv"',
        'Cache-Control': 'no-store',
      });
    } else {
      throw new ValidationError('format must be "json" or "csv"', { field: 'format' });
    }
  });

  router.post('/api/import', ...guard('admin'), async (ctx) => {
    const type = mediaType(ctx.req);
    if (type !== 'application/json' && type !== 'text/csv') {
      throw new UnsupportedMediaTypeError('Content-Type must be application/json or text/csv');
    }
    const query = queryToObject(ctx.query);
    rejectUnknownFields(query, ['onConflict', 'dryRun']);
    const onConflict = query.onConflict ?? 'skip';
    if (!CONFLICT_POLICIES.includes(onConflict)) {
      throw new ValidationError(`onConflict must be one of: ${CONFLICT_POLICIES.join(', ')}`, { field: 'onConflict' });
    }
    if (query.dryRun !== undefined && query.dryRun !== 'true' && query.dryRun !== 'false') {
      throw new ValidationError('dryRun must be true or false', { field: 'dryRun' });
    }
    const body = await readBody(ctx.req, maxImportBytes);
    const records = parseImport(body.toString('utf8'), type === 'text/csv' ? 'csv' : 'json');
    const summary = await importLinks(service, records, {
      onConflict: /** @type {'skip' | 'error' | 'overwrite'} */ (onConflict),
      dryRun: query.dryRun === 'true',
    });
    sendJson(ctx.res, 200, summary);
  });

  registerRedirectRoutes(router, service);

  const pipeline = compose([
    requestLog(logger, clock),
    errorBoundary(logger),
    async (ctx) => {
      const { route, params } = router.match(ctx.method, ctx.path);
      ctx.params = params;
      await compose(route.handlers)(ctx);
    },
  ]);

  return async function handle(req, res) {
    await pipeline(createContext(req, res, { trustProxy }));
  };
}
