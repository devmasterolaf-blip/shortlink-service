/**
 * Request-body reading with a hard size limit.
 */

import { PayloadTooLargeError, UnsupportedMediaTypeError, ValidationError } from '../errors.js';

/**
 * Media type of the request without parameters, lower-cased ("" if absent).
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function mediaType(req) {
  const value = req.headers['content-type'];
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
}

/**
 * Read the whole request body, refusing to buffer more than `limitBytes`.
 *
 * A declared `Content-Length` above the limit is rejected before reading
 * anything; a body that turns out to be longer than declared (or is sent
 * chunked) is rejected as soon as the limit is crossed, and the rest of the
 * stream is discarded.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limitBytes
 * @returns {Promise<Buffer>}
 */
export function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) {
      req.resume();
      reject(new PayloadTooLargeError(limitBytes));
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let received = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const onData = (/** @type {Buffer} */ chunk) => {
      received += chunk.length;
      if (received > limitBytes) {
        cleanup();
        req.resume();
        reject(new PayloadTooLargeError(limitBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (/** @type {Error} */ err) => {
      cleanup();
      reject(err);
    };
    const onAborted = () => {
      cleanup();
      reject(new ValidationError('Request body was not received completely', { code: 'request_aborted' }));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limitBytes
 * @returns {Promise<unknown>}
 */
export async function readJson(req, limitBytes) {
  const type = mediaType(req);
  if (type !== 'application/json') {
    throw new UnsupportedMediaTypeError(
      `Content-Type must be application/json${type === '' ? '' : ` (got ${type})`}`,
    );
  }
  const body = await readBody(req, limitBytes);
  return parseJson(body);
}

/**
 * @param {Buffer} body
 * @returns {unknown}
 */
export function parseJson(body) {
  if (body.length === 0) throw new ValidationError('Request body must not be empty', { code: 'invalid_json' });
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (err) {
    throw new ValidationError(`Request body is not valid JSON: ${/** @type {Error} */ (err).message}`, {
      code: 'invalid_json',
    });
  }
}
