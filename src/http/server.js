/**
 * HTTP server lifecycle: listening and graceful shutdown.
 */

import { createServer } from 'node:http';

/**
 * @typedef {object} ManagedServer
 * @property {import('node:http').Server} server
 * @property {(port: number, host?: string) => Promise<{ port: number, host: string }>} listen
 * @property {() => Promise<void>} close stop accepting connections, let in-flight requests finish, then resolve
 * @property {() => boolean} isClosing
 */

/**
 * Wrap a request handler in an HTTP server that can shut down gracefully.
 *
 * `close()` stops accepting new connections, closes idle keep-alive
 * connections, asks busy ones to close after their current response
 * (`Connection: close`), and force-closes whatever is still open after
 * `shutdownGraceMs`.
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>} handler
 * @param {{ shutdownGraceMs?: number, requestTimeoutMs?: number }} [options]
 * @returns {ManagedServer}
 */
export function createHttpServer(handler, options = {}) {
  const shutdownGraceMs = options.shutdownGraceMs ?? 10_000;
  let closing = false;
  /** @type {Promise<void> | null} */
  let closed = null;

  const server = createServer((req, res) => {
    if (closing) res.setHeader('Connection', 'close');
    Promise.resolve(handler(req, res)).catch(() => {
      // The handler has its own error boundary; this only guards against a
      // failure inside that boundary so the socket is not left hanging.
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  if (options.requestTimeoutMs !== undefined) server.requestTimeout = options.requestTimeoutMs;

  return {
    server,
    isClosing: () => closing,

    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const onError = (/** @type {Error} */ err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          const address = /** @type {import('node:net').AddressInfo} */ (server.address());
          resolve({ port: address.port, host: address.address });
        });
      });
    },

    close() {
      if (closed) return closed;
      closing = true;
      closed = new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        const forceTimer = setTimeout(() => server.closeAllConnections(), shutdownGraceMs);
        server.close((err) => {
          clearTimeout(forceTimer);
          if (err) reject(err);
          else resolve();
        });
        server.closeIdleConnections();
      });
      return closed;
    },
  };
}
