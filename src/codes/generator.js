/**
 * Short-code generators. A generator only proposes codes; the service layer
 * checks each proposal against the store and the reserved words and asks
 * again (passing the attempt number) when it cannot be used.
 *
 * @typedef {object} CodeGenerator
 * @property {(attempt?: number) => string} next propose a code; `attempt` counts earlier rejected proposals
 */

import { randomInt as cryptoRandomInt } from 'node:crypto';
import { BASE62_ALPHABET, CodePermutation } from './base62.js';

/**
 * Sequential generator: takes the next counter value from the store and
 * scrambles it with a {@link CodePermutation}. Never repeats a code by
 * itself, so retries only happen when a custom alias already took the code.
 * @implements {CodeGenerator}
 */
export class CounterCodeGenerator {
  /**
   * @param {{ store: Pick<import('../storage/memoryStore.js').LinkStore, 'nextSequence'>, permutation?: CodePermutation }} options
   */
  constructor({ store, permutation = new CodePermutation() }) {
    this.store = store;
    this.permutation = permutation;
  }

  next() {
    return this.permutation.encode(this.store.nextSequence());
  }
}

/**
 * Random generator: uniform base62 strings from the system CSPRNG. After
 * every `escalateEvery` rejected proposals the code gets one character
 * longer, so a crowded code space resolves itself instead of failing.
 * @implements {CodeGenerator}
 */
export class RandomCodeGenerator {
  /**
   * @param {{ length?: number, escalateEvery?: number, randomInt?: (max: number) => number }} [options]
   *   `randomInt(max)` must return a uniform integer in `[0, max)`; injectable for tests.
   */
  constructor({ length = 7, escalateEvery = 3, randomInt = cryptoRandomInt } = {}) {
    if (!Number.isInteger(length) || length < 1) throw new RangeError('length must be a positive integer');
    if (!Number.isInteger(escalateEvery) || escalateEvery < 1) {
      throw new RangeError('escalateEvery must be a positive integer');
    }
    this.length = length;
    this.escalateEvery = escalateEvery;
    this.randomInt = randomInt;
  }

  /** @param {number} [attempt] */
  next(attempt = 0) {
    const length = this.length + Math.floor(attempt / this.escalateEvery);
    let code = '';
    for (let i = 0; i < length; i++) code += BASE62_ALPHABET[this.randomInt(BASE62_ALPHABET.length)];
    return code;
  }
}
