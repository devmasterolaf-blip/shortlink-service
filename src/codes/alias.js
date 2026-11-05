/**
 * Rules for user-chosen aliases and for words that may never be used as a
 * short code because they would shadow service routes.
 */

import { ValidationError } from '../errors.js';

/** Lower-case words that can never be used as a code or alias. */
export const DEFAULT_RESERVED_WORDS = Object.freeze([
  'api',
  'admin',
  'health',
  'healthz',
  'static',
  'assets',
  'login',
  'logout',
  'signup',
  'new',
  'stats',
  'docs',
  'help',
  'about',
]);

export const ALIAS_MIN_LENGTH = 3;
export const ALIAS_MAX_LENGTH = 32;

/**
 * @param {string} code
 * @param {readonly string[]} [reserved]
 * @returns {boolean}
 */
export function isReservedWord(code, reserved = DEFAULT_RESERVED_WORDS) {
  return reserved.includes(code.toLowerCase());
}

/**
 * Validate a custom alias and return it unchanged.
 *
 * Allowed: ASCII letters, digits, "-" and "_"; it must start and end with a
 * letter or digit, be 3..32 characters long and must not be a reserved word
 * (compared case-insensitively).
 *
 * @param {unknown} alias
 * @param {{ minLength?: number, maxLength?: number, reserved?: readonly string[] }} [options]
 * @returns {string}
 */
export function validateAlias(alias, options = {}) {
  const minLength = options.minLength ?? ALIAS_MIN_LENGTH;
  const maxLength = options.maxLength ?? ALIAS_MAX_LENGTH;
  const fail = (/** @type {string} */ message, /** @type {string} */ code) =>
    new ValidationError(message, { field: 'alias', code });

  if (typeof alias !== 'string') throw fail('alias must be a string', 'alias_invalid');
  if (alias.length < minLength || alias.length > maxLength) {
    throw fail(`alias must be ${minLength} to ${maxLength} characters long`, 'alias_length');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(alias)) {
    throw fail('alias may only contain letters, digits, "-" and "_"', 'alias_invalid');
  }
  if (!/^[A-Za-z0-9]/.test(alias) || !/[A-Za-z0-9]$/.test(alias)) {
    throw fail('alias must start and end with a letter or digit', 'alias_invalid');
  }
  if (isReservedWord(alias, options.reserved)) {
    throw fail(`alias "${alias}" is reserved`, 'alias_reserved');
  }
  return alias;
}
