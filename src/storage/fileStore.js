/**
 * Durable storage: an append-only journal of JSON lines.
 *
 * `FileStore` is a `MemoryStore` whose commit hook writes each journal
 * record to disk before applying it. Opening a store replays the file;
 * compaction rewrites it as a snapshot of the live state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { StorageError } from '../errors.js';
import { serializeStats } from '../analytics/stats.js';
import { MemoryStore } from './memoryStore.js';

const NEWLINE = 0x0a;

/**
 * @typedef {object} FileStoreOptions
 * @property {'always' | 'never'} [fsync] `always` (default) flushes every
 *   record to the device before the change is acknowledged; `never` leaves
 *   flushing to the operating system (faster, may lose the last records on
 *   power loss, never corrupts earlier ones)
 * @property {import('../analytics/stats.js').StatsLimits} [statsLimits]
 */

/**
 * @typedef {object} RecoveryInfo
 * @property {number} records journal records replayed
 * @property {number} droppedBytes size of a torn final record that was cut off
 * @property {boolean} repairedNewline a complete final record lacked its newline
 */

/**
 * @param {unknown} value
 * @returns {value is import('./memoryStore.js').JournalRecord}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && typeof (/** @type {any} */ (value).op) === 'string';
}

export class FileStore extends MemoryStore {
  /**
   * Open (or create) the journal at `filePath` and replay it.
   * @param {string} filePath
   * @param {FileStoreOptions} [options]
   * @returns {FileStore}
   */
  static open(filePath, options = {}) {
    const store = new FileStore(filePath, options);
    store._open();
    return store;
  }

  /**
   * @param {string} filePath
   * @param {FileStoreOptions} [options]
   * @private use {@link FileStore.open}
   */
  constructor(filePath, options = {}) {
    super(options.statsLimits);
    this.path = path.resolve(filePath);
    this._fsync = options.fsync ?? 'always';
    /** @type {number | null} */
    this._fd = null;
    /** Records currently in the file (replayed plus appended). */
    this._records = 0;
    /** @type {RecoveryInfo} */
    this.recovery = { records: 0, droppedBytes: 0, repairedNewline: false };
  }

  /** @private */
  _open() {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      // A leftover temp file means a compaction died before its rename; the
      // journal itself is still complete.
      fs.rmSync(this._tempPath(), { force: true });
      // The journal holds password hashes: readable by the owner only.
      this._fd = fs.openSync(this.path, 'a+', 0o600);
    } catch (err) {
      throw new StorageError(`Cannot open data file ${this.path}`, { cause: err });
    }
    try {
      this._replay(fs.readFileSync(this._fd));
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /**
   * Rebuild the in-memory state from the journal contents.
   *
   * A crash can tear only the record being appended, so damage is tolerated
   * in exactly one place: a final segment without a terminating newline.
   * If it does not parse it is cut off; anything unreadable before that
   * point means the file was damaged some other way and is reported.
   *
   * @param {Buffer} data
   * @private
   */
  _replay(data) {
    const fd = /** @type {number} */ (this._fd);
    let offset = 0;
    let lineNumber = 0;
    while (offset < data.length) {
      lineNumber += 1;
      const newlineAt = data.indexOf(NEWLINE, offset);
      const end = newlineAt === -1 ? data.length : newlineAt;
      const text = data.toString('utf8', offset, end).trim();
      /** @type {unknown} */
      let record;
      let readable = true;
      try {
        record = text === '' ? null : JSON.parse(text);
        if (record !== null) {
          if (!isRecord(record)) throw new TypeError('not a journal record');
          this._apply(record);
        }
      } catch {
        readable = false;
      }
      if (!readable) {
        if (newlineAt !== -1) {
          throw new StorageError(`Data file ${this.path} is corrupt at line ${lineNumber}`, {
            details: { line: lineNumber },
          });
        }
        this.recovery.droppedBytes = data.length - offset;
        fs.ftruncateSync(fd, offset);
        this._sync(true);
        break;
      }
      if (record !== null) this._records += 1;
      if (newlineAt === -1 && text !== '') {
        fs.writeSync(fd, '\n');
        this._sync(true);
        this.recovery.repairedNewline = true;
      }
      offset = end + 1;
    }
    this.recovery.records = this._records;
  }

  /** @param {boolean} [force] flush even when the policy is `never` */
  _sync(force = false) {
    if (this._fd !== null && (force || this._fsync === 'always')) fs.fsyncSync(this._fd);
  }

  _tempPath() {
    return `${this.path}.tmp`;
  }

  /**
   * @param {import('./memoryStore.js').JournalRecord} record
   * @protected
   * @override
   */
  _commit(record) {
    if (this._fd === null) throw new StorageError('The store is closed');
    try {
      const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      let written = 0;
      while (written < line.length) written += fs.writeSync(this._fd, line, written);
      this._sync();
    } catch (err) {
      throw new StorageError(`Cannot write to data file ${this.path}`, { cause: err });
    }
    this._records += 1;
    this._apply(record);
  }

  /** Records needed to describe the current state from scratch. */
  _snapshot() {
    /** @type {import('./memoryStore.js').JournalRecord[]} */
    const records = [{ op: 'seq', value: this._sequence }];
    for (const link of this.listLinks()) {
      records.push({ op: 'put', link });
      const stats = this._stats.get(link.code);
      if (stats && stats.total > 0) records.push({ op: 'stats', code: link.code, stats: serializeStats(stats) });
    }
    return records;
  }

  /**
   * Rewrite the journal as a snapshot of the live state. The snapshot is
   * written to a temporary file, flushed, and renamed over the journal, so a
   * crash at any point leaves either the old or the new file, never a mix.
   *
   * @returns {{ recordsBefore: number, recordsAfter: number, bytesBefore: number, bytesAfter: number }}
   */
  compact() {
    if (this._fd === null) throw new StorageError('The store is closed');
    const records = this._snapshot();
    const tempPath = this._tempPath();
    const recordsBefore = this._records;
    try {
      const bytesBefore = fs.fstatSync(this._fd).size;
      const tempFd = fs.openSync(tempPath, 'w', 0o600);
      try {
        fs.writeSync(tempFd, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
        fs.fsyncSync(tempFd);
      } finally {
        fs.closeSync(tempFd);
      }
      fs.renameSync(tempPath, this.path);
      fs.closeSync(this._fd);
      this._fd = fs.openSync(this.path, 'a+', 0o600);
      this._records = records.length;
      return { recordsBefore, recordsAfter: records.length, bytesBefore, bytesAfter: fs.fstatSync(this._fd).size };
    } catch (err) {
      fs.rmSync(tempPath, { force: true });
      throw new StorageError(`Cannot compact data file ${this.path}`, { cause: err });
    }
  }

  /** Number of records currently in the journal file. */
  get journalRecords() {
    return this._records;
  }

  /** @override */
  close() {
    if (this._fd === null) return;
    const fd = this._fd;
    this._fd = null;
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}
