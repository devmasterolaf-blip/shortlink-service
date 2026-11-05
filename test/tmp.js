/**
 * Temporary directories for tests that touch the file system. They live
 * under `.scratch/` in the repository (git-ignored) unless
 * `SHORTLINK_TEST_TMPDIR` points somewhere else, and are removed when the
 * owning test finishes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.SHORTLINK_TEST_TMPDIR
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.scratch');

/**
 * @param {import('node:test').TestContext} t
 * @returns {string} an empty directory
 */
export function tempDir(t) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
