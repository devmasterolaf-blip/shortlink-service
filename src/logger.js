/**
 * Structured logging: one JSON object per line.
 */

import { systemClock } from './clock.js';

/**
 * @param {{ level?: 'info' | 'error' | 'silent', write?: (line: string) => void, clock?: import('./clock.js').Clock }} [options]
 *   `write` receives each finished line including its newline (default: stderr)
 * @returns {import('./http/middleware.js').Logger}
 */
export function createLogger(options = {}) {
  const level = options.level ?? 'info';
  const write = options.write ?? ((line) => void process.stderr.write(line));
  const clock = options.clock ?? systemClock;

  /** @param {'info' | 'error'} severity */
  const emitter = (severity) => (/** @type {string} */ message, /** @type {Record<string, unknown>} */ fields = {}) => {
    // Fixed keys come last so a field can never overwrite them.
    write(`${JSON.stringify({ ...fields, time: new Date(clock.now()).toISOString(), level: severity, msg: message })}\n`);
  };
  const off = () => {};
  return {
    info: level === 'info' ? emitter('info') : off,
    error: level === 'silent' ? off : emitter('error'),
  };
}
