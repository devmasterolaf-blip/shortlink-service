/**
 * Password hashing for protected links, built on scrypt from `node:crypto`.
 *
 * Hashes are stored as a self-describing string so that cost parameters can
 * be raised later without invalidating existing hashes:
 *
 *   scrypt$<N>$<r>$<p>$<salt base64url>$<key base64url>
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * @typedef {object} ScryptCost
 * @property {number} N CPU/memory cost, a power of two
 * @property {number} r block size
 * @property {number} p parallelisation
 */

/** @type {Readonly<ScryptCost>} */
export const DEFAULT_SCRYPT_COST = Object.freeze({ N: 16384, r: 8, p: 1 });

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
/** Upper bound accepted when verifying, so a tampered hash cannot demand unbounded work. */
const MAX_N = 2 ** 20;

/**
 * @param {string} password
 * @param {Buffer} salt
 * @param {ScryptCost} cost
 * @param {number} keyLength
 * @returns {Promise<Buffer>}
 */
function derive(password, salt, cost, keyLength) {
  return new Promise((resolve, reject) => {
    const options = { N: cost.N, r: cost.r, p: cost.p, maxmem: 256 * cost.N * cost.r };
    scrypt(password.normalize('NFKC'), salt, keyLength, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * @param {string} password
 * @param {ScryptCost} [cost]
 * @returns {Promise<string>} encoded hash
 */
export async function hashPassword(password, cost = DEFAULT_SCRYPT_COST) {
  if (typeof password !== 'string' || password === '') {
    throw new TypeError('password must be a non-empty string');
  }
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, cost, KEY_LENGTH);
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * @param {string} encoded
 * @returns {{ cost: ScryptCost, salt: Buffer, key: Buffer } | null}
 */
function parseHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const validCost =
    Number.isInteger(N) && N > 1 && N <= MAX_N && (N & (N - 1)) === 0 &&
    Number.isInteger(r) && r > 0 && r <= 32 &&
    Number.isInteger(p) && p > 0 && p <= 16;
  if (!validCost) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length === 0 || key.length === 0) return null;
  return { cost: { N, r, p }, salt, key };
}

/**
 * Check `password` against an encoded hash in constant time. Malformed
 * hashes verify as false instead of throwing.
 * @param {string} password
 * @param {string} encoded
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, encoded) {
  const parsed = parseHash(encoded);
  if (!parsed || typeof password !== 'string') return false;
  const candidate = await derive(password, parsed.salt, parsed.cost, parsed.key.length);
  return timingSafeEqual(candidate, parsed.key);
}

/**
 * True when `encoded` was produced with weaker parameters than `cost`.
 * @param {string} encoded
 * @param {ScryptCost} [cost]
 * @returns {boolean}
 */
export function needsRehash(encoded, cost = DEFAULT_SCRYPT_COST) {
  const parsed = parseHash(encoded);
  if (!parsed) return true;
  return parsed.cost.N < cost.N || parsed.cost.r < cost.r || parsed.cost.p < cost.p;
}

/**
 * @param {unknown} encoded
 * @returns {boolean}
 */
export function isPasswordHash(encoded) {
  return typeof encoded === 'string' && parseHash(encoded) !== null;
}
