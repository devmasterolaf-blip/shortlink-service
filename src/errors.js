/**
 * Typed error classes shared by every layer.
 *
 * Each error carries a stable machine-readable `code`, the HTTP status the
 * HTTP layer should answer with, and optional structured `details`.
 */

export class AppError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, details?: unknown, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    /** @type {string} */
    this.code = options.code ?? 'internal_error';
    /** @type {number} */
    this.status = options.status ?? 500;
    /** @type {unknown} */
    this.details = options.details;
  }
}

/** A request or input value failed validation. */
export class ValidationError extends AppError {
  /**
   * @param {string} message
   * @param {{ field?: string, code?: string, details?: unknown }} [options]
   */
  constructor(message, options = {}) {
    const details =
      options.details ?? (options.field === undefined ? undefined : { field: options.field });
    super(message, { code: options.code ?? 'validation_error', status: 400, details });
    /** @type {string | undefined} */
    this.field = options.field;
  }
}

export class NotFoundError extends AppError {
  /** @param {string} message @param {{ code?: string }} [options] */
  constructor(message, options = {}) {
    super(message, { code: options.code ?? 'not_found', status: 404 });
  }
}

export class ConflictError extends AppError {
  /** @param {string} message @param {{ code?: string, details?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, { code: options.code ?? 'conflict', status: 409, details: options.details });
  }
}

/** The resource existed but is permanently unavailable (expired, exhausted). */
export class GoneError extends AppError {
  /** @param {string} message @param {{ code?: string }} [options] */
  constructor(message, options = {}) {
    super(message, { code: options.code ?? 'gone', status: 410 });
  }
}

export class UnauthorizedError extends AppError {
  /** @param {string} message @param {{ code?: string }} [options] */
  constructor(message, options = {}) {
    super(message, { code: options.code ?? 'unauthorized', status: 401 });
  }
}

export class ForbiddenError extends AppError {
  /** @param {string} message @param {{ code?: string, details?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, { code: options.code ?? 'forbidden', status: 403, details: options.details });
  }
}

export class MethodNotAllowedError extends AppError {
  /** @param {string[]} allowed */
  constructor(allowed) {
    super(`Method not allowed; use one of: ${allowed.join(', ')}`, {
      code: 'method_not_allowed',
      status: 405,
      details: { allowed },
    });
    /** @type {string[]} */
    this.allowed = allowed;
  }
}

export class PayloadTooLargeError extends AppError {
  /** @param {number} limitBytes */
  constructor(limitBytes) {
    super(`Request body exceeds the limit of ${limitBytes} bytes`, {
      code: 'payload_too_large',
      status: 413,
      details: { limitBytes },
    });
    /** @type {number} */
    this.limitBytes = limitBytes;
  }
}

export class UnsupportedMediaTypeError extends AppError {
  /** @param {string} message */
  constructor(message) {
    super(message, { code: 'unsupported_media_type', status: 415 });
  }
}

export class RateLimitedError extends AppError {
  /** @param {number} retryAfterSeconds whole seconds until a retry can succeed */
  constructor(retryAfterSeconds) {
    super(`Rate limit exceeded; retry in ${retryAfterSeconds}s`, {
      code: 'rate_limited',
      status: 429,
      details: { retryAfterSeconds },
    });
    /** @type {number} */
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The storage layer could not read or write its backing data. */
export class StorageError extends AppError {
  /** @param {string} message @param {{ cause?: unknown, details?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, {
      code: 'storage_error',
      status: 500,
      details: options.details,
      cause: options.cause,
    });
  }
}

/** Invalid process configuration; lists every problem found. */
export class ConfigError extends AppError {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`, {
      code: 'config_error',
      status: 500,
      details: { problems },
    });
    /** @type {string[]} */
    this.problems = problems;
  }
}

/**
 * @typedef {object} ErrorEnvelope
 * @property {{ code: string, message: string, details?: unknown, requestId?: string }} error
 */

/**
 * Convert any thrown value into the HTTP status and JSON envelope used by
 * every error response. Unknown errors are reported as an opaque 500 so that
 * internal messages never leak to clients.
 *
 * @param {unknown} err
 * @param {string} [requestId]
 * @returns {{ status: number, body: ErrorEnvelope }}
 */
export function toErrorResponse(err, requestId) {
  /** @type {ErrorEnvelope['error']} */
  let error;
  let status = 500;
  if (err instanceof AppError && err.status < 500) {
    status = err.status;
    error = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
  } else {
    error = { code: 'internal_error', message: 'Internal server error' };
  }
  if (requestId !== undefined) error.requestId = requestId;
  return { status, body: { error } };
}
