/**
 * The public redirect endpoint: `GET /:code` follows a link, `POST /:code`
 * unlocks a password-protected one.
 */

import { UnsupportedMediaTypeError } from '../errors.js';
import { mediaType, parseJson, readBody } from './body.js';
import { header, sendText } from './context.js';

/** Header a client can use to send the link password with a plain GET. */
export const LINK_PASSWORD_HEADER = 'x-link-password';

/** Unlock forms are tiny; anything bigger is not a password. */
const MAX_UNLOCK_BODY_BYTES = 1024;

/**
 * Read the password from an unlock request (JSON object or HTML form).
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string | undefined>} undefined when the body carries no usable password
 */
async function readUnlockPassword(req) {
  const type = mediaType(req);
  if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded') {
    throw new UnsupportedMediaTypeError(
      'Send the password as application/json or application/x-www-form-urlencoded',
    );
  }
  const body = await readBody(req, MAX_UNLOCK_BODY_BYTES);
  /** @type {unknown} */
  let password;
  if (type === 'application/json') {
    const parsed = parseJson(body);
    password = parsed !== null && typeof parsed === 'object' ? /** @type {any} */ (parsed).password : undefined;
  } else {
    password = new URLSearchParams(body.toString('utf8')).get('password');
  }
  return typeof password === 'string' ? password : undefined;
}

/**
 * @param {import('./context.js').RequestContext} ctx
 * @param {{ url: string, status: number, cacheControl: string }} target
 */
function sendRedirect(ctx, target) {
  sendText(ctx.res, target.status, `Redirecting to ${target.url}\n`, {
    Location: target.url,
    'Cache-Control': target.cacheControl,
    'Referrer-Policy': 'no-referrer',
  });
}

/**
 * @param {import('./router.js').Router<import('./context.js').RequestContext>} router
 * @param {import('../service/linkService.js').LinkService} service
 */
export function registerRedirectRoutes(router, service) {
  /** @param {import('./context.js').RequestContext} ctx */
  const visitor = (ctx) => ({
    ip: ctx.ip,
    referrer: header(ctx.req, 'referer'),
    userAgent: header(ctx.req, 'user-agent'),
  });

  // HEAD is routed here too. Link checkers and chat previews send HEAD, so
  // it answers like GET but does not count as a click.
  router.get('/:code', async (ctx) => {
    const target = await service.resolve(ctx.params.code, {
      ...visitor(ctx),
      password: header(ctx.req, LINK_PASSWORD_HEADER),
      countClick: ctx.method !== 'HEAD',
    });
    sendRedirect(ctx, target);
  });

  // The answer is always 303 and never cacheable: a 307 would make the
  // browser re-post the password to the destination.
  router.post('/:code', async (ctx) => {
    const password = await readUnlockPassword(ctx.req);
    const target = await service.resolve(ctx.params.code, { ...visitor(ctx), password });
    sendRedirect(ctx, { url: target.url, status: 303, cacheControl: 'no-store' });
  });
}
