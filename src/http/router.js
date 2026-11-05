/**
 * A small path router.
 *
 * Patterns are made of static segments and `:name` parameters, for example
 * `/api/links/:code/stats`. When several routes match a path the most
 * specific one wins (the one with more static segments), so `/healthz` is
 * never captured by `/:code`.
 */

import { MethodNotAllowedError, NotFoundError, ValidationError } from '../errors.js';

/**
 * @template C
 * @typedef {(ctx: C, next: () => Promise<void>) => Promise<void> | void} Middleware
 */

/**
 * @template C
 * @typedef {object} Route
 * @property {string} method
 * @property {string} pattern
 * @property {Array<{ param: string } | { literal: string }>} segments
 * @property {number} specificity number of static segments
 * @property {Middleware<C>[]} handlers
 */

/**
 * @param {string} path
 * @returns {string[]}
 */
function splitPath(path) {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return trimmed.split('/').slice(1);
}

/** @template C */
export class Router {
  constructor() {
    /** @type {Route<C>[]} */
    this.routes = [];
  }

  /**
   * @param {string} method
   * @param {string} pattern
   * @param {...Middleware<C>} handlers
   * @returns {this}
   */
  add(method, pattern, ...handlers) {
    if (!pattern.startsWith('/')) throw new TypeError(`Route pattern must start with "/": ${pattern}`);
    if (handlers.length === 0) throw new TypeError(`Route ${method} ${pattern} has no handler`);
    const segments = splitPath(pattern).map((segment) =>
      segment.startsWith(':') ? { param: segment.slice(1) } : { literal: segment },
    );
    const names = segments.flatMap((segment) => ('param' in segment ? [segment.param] : []));
    if (names.some((name) => !/^[A-Za-z_]\w*$/.test(name)) || new Set(names).size !== names.length) {
      throw new TypeError(`Route pattern has invalid or duplicate parameters: ${pattern}`);
    }
    const upperMethod = method.toUpperCase();
    if (this.routes.some((route) => route.method === upperMethod && route.pattern === pattern)) {
      throw new TypeError(`Route ${upperMethod} ${pattern} is already registered`);
    }
    this.routes.push({
      method: upperMethod,
      pattern,
      segments,
      specificity: segments.filter((segment) => 'literal' in segment).length,
      handlers,
    });
    return this;
  }

  /** @param {string} pattern @param {...Middleware<C>} handlers */
  get(pattern, ...handlers) {
    return this.add('GET', pattern, ...handlers);
  }

  /** @param {string} pattern @param {...Middleware<C>} handlers */
  post(pattern, ...handlers) {
    return this.add('POST', pattern, ...handlers);
  }

  /** @param {string} pattern @param {...Middleware<C>} handlers */
  patch(pattern, ...handlers) {
    return this.add('PATCH', pattern, ...handlers);
  }

  /** @param {string} pattern @param {...Middleware<C>} handlers */
  delete(pattern, ...handlers) {
    return this.add('DELETE', pattern, ...handlers);
  }

  /**
   * Find the route for a request.
   *
   * A HEAD request falls back to the GET route when no HEAD route exists.
   * Throws `NotFoundError` when no pattern matches the path and
   * `MethodNotAllowedError` when patterns match but not for this method.
   *
   * @param {string} method
   * @param {string} path URL path, still percent-encoded
   * @returns {{ route: Route<C>, params: Record<string, string> }}
   */
  match(method, path) {
    const parts = splitPath(path);
    const upperMethod = method.toUpperCase();
    /** @type {Route<C>[]} */
    const candidates = [];
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const fits = route.segments.every((segment, index) =>
        'literal' in segment ? segment.literal === parts[index] : parts[index] !== '',
      );
      if (fits) candidates.push(route);
    }
    if (candidates.length === 0) throw new NotFoundError(`No route for ${path}`, { code: 'route_not_found' });

    // Only the most specific pattern(s) are considered, so a static route
    // shadows a parameterised one for every method.
    const best = Math.max(...candidates.map((route) => route.specificity));
    const specific = candidates.filter((route) => route.specificity === best);
    const route =
      specific.find((candidate) => candidate.method === upperMethod) ??
      (upperMethod === 'HEAD' ? specific.find((candidate) => candidate.method === 'GET') : undefined);
    if (!route) {
      const allowed = new Set(specific.map((candidate) => candidate.method));
      if (allowed.has('GET')) allowed.add('HEAD');
      throw new MethodNotAllowedError([...allowed].sort());
    }

    /** @type {Record<string, string>} */
    const params = {};
    route.segments.forEach((segment, index) => {
      if (!('param' in segment)) return;
      try {
        params[segment.param] = decodeURIComponent(parts[index]);
      } catch {
        throw new ValidationError('Request path contains an invalid percent-encoding', { code: 'bad_path' });
      }
    });
    return { route, params };
  }
}

/**
 * Chain middleware into one function. Each middleware receives the context
 * and a `next` function that runs the rest of the chain; calling `next`
 * twice is a programming error and rejects.
 *
 * @template C
 * @param {Middleware<C>[]} middleware
 * @returns {(ctx: C) => Promise<void>}
 */
export function compose(middleware) {
  return async function run(ctx) {
    let lastIndex = -1;
    /** @param {number} index @returns {Promise<void>} */
    async function dispatch(index) {
      if (index <= lastIndex) throw new Error('next() called more than once');
      lastIndex = index;
      const fn = middleware[index];
      if (fn) await fn(ctx, () => dispatch(index + 1));
    }
    await dispatch(0);
  };
}
