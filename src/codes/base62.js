/**
 * Base62 encoding and the obfuscating permutation used for counter-based
 * short codes.
 *
 * A plain base62 counter produces guessable, sequential codes ("0001",
 * "0002", ...). `CodePermutation` maps every counter value to a distinct code
 * of the same length through an affine bijection modulo 62^length, so
 * consecutive counters land far apart while uniqueness is still guaranteed
 * without a database lookup.
 */

import { createHash } from 'node:crypto';

export const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const BASE = 62n;
const DIGIT_VALUES = new Map([...BASE62_ALPHABET].map((ch, index) => [ch, BigInt(index)]));

/**
 * Encode a non-negative integer as base62, left-padded with "0" to `minLength`.
 * @param {bigint | number} value
 * @param {number} [minLength]
 * @returns {string}
 */
export function encodeBase62(value, minLength = 1) {
  let n = toBigInt(value);
  let out = '';
  do {
    out = BASE62_ALPHABET[Number(n % BASE)] + out;
    n /= BASE;
  } while (n > 0n);
  return out.padStart(minLength, '0');
}

/**
 * @param {string} text
 * @returns {bigint}
 */
export function decodeBase62(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('decodeBase62() needs a non-empty string');
  }
  let n = 0n;
  for (const ch of text) {
    const digit = DIGIT_VALUES.get(ch);
    if (digit === undefined) throw new RangeError(`Invalid base62 character: ${JSON.stringify(ch)}`);
    n = n * BASE + digit;
  }
  return n;
}

/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function isBase62(text) {
  return typeof text === 'string' && /^[0-9A-Za-z]+$/.test(text);
}

/**
 * @param {bigint | number} value
 * @returns {bigint}
 */
function toBigInt(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError('Expected a safe integer');
    value = BigInt(value);
  }
  if (typeof value !== 'bigint') throw new TypeError('Expected a bigint or an integer number');
  if (value < 0n) throw new RangeError('Expected a non-negative integer');
  return value;
}

/**
 * Modular multiplicative inverse of `a` modulo `m` (extended Euclid).
 * @param {bigint} a
 * @param {bigint} m
 * @returns {bigint}
 */
function modInverse(a, m) {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new RangeError('Multiplier is not invertible for this modulus');
  return ((oldS % m) + m) % m;
}

const DEFAULT_MULTIPLIER = 2654435761n;
const DEFAULT_INCREMENT = 1013904223n;

/**
 * Bijective counter -> code mapping.
 *
 * Counters are assigned to "tiers" by code length: the first 62^minLength
 * counters get codes of `minLength` characters, the next 62^(minLength + 1)
 * get one more character, and so on. Inside a tier the index is scrambled as
 * `(index * multiplier + increment) mod 62^length`, which is a bijection
 * because the multiplier is coprime with 62.
 */
export class CodePermutation {
  /**
   * @param {{ minLength?: number, maxLength?: number, multiplier?: bigint, increment?: bigint, secret?: string }} [options]
   *   `secret` derives multiplier and increment deterministically, so each
   *   deployment can have its own code sequence.
   */
  constructor(options = {}) {
    const minLength = options.minLength ?? 4;
    const maxLength = options.maxLength ?? 12;
    if (!Number.isInteger(minLength) || minLength < 1) {
      throw new RangeError('minLength must be a positive integer');
    }
    if (!Number.isInteger(maxLength) || maxLength < minLength) {
      throw new RangeError('maxLength must be an integer >= minLength');
    }
    let multiplier = options.multiplier ?? DEFAULT_MULTIPLIER;
    let increment = options.increment ?? DEFAULT_INCREMENT;
    if (options.secret !== undefined) {
      const digest = createHash('sha256').update(options.secret).digest();
      multiplier = digest.readBigUInt64BE(0) | 1n;
      if (multiplier % 31n === 0n) multiplier += 2n;
      increment = digest.readBigUInt64BE(8);
    }
    if (multiplier <= 0n || multiplier % 2n === 0n || multiplier % 31n === 0n) {
      throw new RangeError('multiplier must be positive and coprime with 62');
    }
    if (increment < 0n) throw new RangeError('increment must not be negative');
    this.minLength = minLength;
    this.maxLength = maxLength;
    this.multiplier = multiplier;
    this.increment = increment;
  }

  /** Total number of distinct codes this permutation can produce. */
  get capacity() {
    let total = 0n;
    for (let length = this.minLength; length <= this.maxLength; length++) total += BASE ** BigInt(length);
    return total;
  }

  /**
   * @param {bigint | number} counter zero-based sequence number
   * @returns {string}
   */
  encode(counter) {
    let index = toBigInt(counter);
    for (let length = this.minLength; length <= this.maxLength; length++) {
      const size = BASE ** BigInt(length);
      if (index < size) {
        const scrambled = (index * this.multiplier + this.increment) % size;
        return encodeBase62(scrambled, length);
      }
      index -= size;
    }
    throw new RangeError('Counter exceeds the capacity of the code space');
  }

  /**
   * Inverse of {@link CodePermutation.encode}.
   * @param {string} code
   * @returns {bigint}
   */
  decode(code) {
    const scrambled = decodeBase62(code);
    const length = code.length;
    if (length < this.minLength || length > this.maxLength) {
      throw new RangeError(`Code length ${length} is outside ${this.minLength}..${this.maxLength}`);
    }
    const size = BASE ** BigInt(length);
    const inverse = modInverse(this.multiplier, size);
    const shifted = (((scrambled - this.increment) % size) + size) % size;
    let index = (shifted * inverse) % size;
    for (let shorter = this.minLength; shorter < length; shorter++) index += BASE ** BigInt(shorter);
    return index;
  }
}
