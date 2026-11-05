/**
 * Shared fixtures for the test suite (not a test file itself).
 */

import { ManualClock } from '../src/clock.js';
import { CodePermutation } from '../src/codes/base62.js';
import { CounterCodeGenerator } from '../src/codes/generator.js';
import { MemoryStore } from '../src/storage/memoryStore.js';
import { LinkService } from '../src/service/linkService.js';

export const T0 = Date.parse('2026-06-01T12:00:00Z');
export const DAY = 86_400_000;

/** Cheap scrypt parameters so password tests stay fast. */
export const FAST_COST = Object.freeze({ N: 1024, r: 8, p: 1 });

/**
 * Build a service on a fresh in-memory store with a manual clock.
 * @param {Partial<import('../src/service/linkService.js').LinkServiceOptions>} [overrides]
 */
export function makeService(overrides = {}) {
  const clock = new ManualClock(T0);
  const store = overrides.store ?? new MemoryStore();
  const generator =
    overrides.generator ?? new CounterCodeGenerator({ store, permutation: new CodePermutation({ minLength: 4 }) });
  const service = new LinkService({
    store,
    generator,
    clock,
    baseUrl: 'https://sho.rt',
    passwordCost: FAST_COST,
    ...overrides,
  });
  return { service, store, clock: /** @type {ManualClock} */ (service.clock) };
}

/**
 * Assert that `fn` throws (or rejects with) an AppError carrying `code`.
 * @param {() => unknown} fn
 * @param {string} code
 * @param {number} [status]
 */
export async function expectError(fn, code, status) {
  /** @type {any} */
  let caught;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  if (!caught) throw new Error(`Expected an error with code "${code}" but nothing was thrown`);
  if (caught.code !== code) {
    throw new Error(`Expected error code "${code}" but got "${caught.code}": ${caught.message}`, { cause: caught });
  }
  if (status !== undefined && caught.status !== status) {
    throw new Error(`Expected status ${status} but got ${caught.status}`);
  }
  return caught;
}
