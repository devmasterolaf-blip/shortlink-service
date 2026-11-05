import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StorageError } from '../src/errors.js';
import { FileStore } from '../src/storage/fileStore.js';
import { T0 } from './helpers.js';
import { tempDir } from './tmp.js';

/** @param {string} code @returns {import('../src/storage/memoryStore.js').Link} */
function link(code) {
  return {
    code,
    url: `https://example.com/${code}`,
    custom: true,
    createdAt: T0,
    updatedAt: T0,
    expiresAt: null,
    maxClicks: null,
    clicks: 0,
    lastClickAt: null,
    passwordHash: null,
    enabled: true,
    tags: ['t'],
    redirectType: 302,
  };
}

/** @param {string} code @param {number} at @param {string} visitor */
const click = (code, at, visitor) => ({ code, at, referrer: '(direct)', userAgent: 'Other', visitor });

/** @param {import('node:test').TestContext} t @param {string} file */
function opener(t, file) {
  /** @type {FileStore[]} */
  const opened = [];
  t.after(() => opened.forEach((store) => store.close()));
  return (/** @type {import('../src/storage/fileStore.js').FileStoreOptions} */ options = { fsync: 'never' }) => {
    const store = FileStore.open(file, options);
    opened.push(store);
    return store;
  };
}

test('state survives closing and reopening', (t) => {
  const file = path.join(tempDir(t), 'nested', 'links.jsonl');
  const open = opener(t, file);
  const first = open({ fsync: 'always' });
  assert.equal(first.nextSequence(), 0);
  assert.equal(first.nextSequence(), 1);
  first.insertLink(link('keep'));
  first.insertLink(link('gone'));
  first.updateLink('keep', { enabled: false, tags: ['a', 'b'] });
  first.recordClick(click('keep', T0 + 5, 'v1'));
  first.recordClick(click('keep', T0 + 9, 'v2'));
  first.deleteLink('gone');
  const expectedLink = first.getLink('keep');
  const expectedStats = first.getStats('keep');
  first.close();
  first.close();

  const second = open();
  assert.deepEqual(second.getLink('keep'), expectedLink);
  assert.equal(expectedLink?.clicks, 2);
  assert.deepEqual(second.getStats('keep'), expectedStats);
  assert.equal(second.hasLink('gone'), false);
  assert.equal(second.nextSequence(), 2);
  assert.deepEqual(second.recovery, { records: 8, droppedBytes: 0, repairedNewline: false });
});

test('the journal is one JSON object per line and private to the owner', (t) => {
  const file = path.join(tempDir(t), 'links.jsonl');
  const store = opener(t, file)();
  store.insertLink(link('abc'));
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines.pop(), '');
  assert.deepEqual(lines.map((line) => JSON.parse(line).op), ['put']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a torn final record is cut off and writing continues cleanly', (t) => {
  const file = path.join(tempDir(t), 'links.jsonl');
  const open = opener(t, file);
  const first = open();
  first.insertLink(link('one'));
  first.insertLink(link('two'));
  first.close();
  const intact = fs.readFileSync(file);
  const torn = intact.subarray(0, intact.length - 25);
  fs.writeFileSync(file, torn);

  const second = open();
  assert.equal(second.hasLink('one'), true);
  assert.equal(second.hasLink('two'), false);
  assert.equal(second.recovery.records, 1);
  assert.ok(second.recovery.droppedBytes > 0);
  second.insertLink(link('three'));
  second.close();

  const third = open();
  assert.deepEqual(third.listLinks().map((item) => item.code), ['one', 'three']);
  assert.equal(third.recovery.droppedBytes, 0);
});

test('a complete final record without its newline is kept and repaired', (t) => {
  const file = path.join(tempDir(t), 'links.jsonl');
  const open = opener(t, file);
  const first = open();
  first.insertLink(link('one'));
  first.close();
  const intact = fs.readFileSync(file);
  fs.writeFileSync(file, intact.subarray(0, intact.length - 1));

  const second = open();
  assert.equal(second.hasLink('one'), true);
  assert.equal(second.recovery.repairedNewline, true);
  second.insertLink(link('two'));
  second.close();
  assert.deepEqual(open().listLinks().map((item) => item.code), ['one', 'two']);
});

test('damage before the final record is reported, not skipped', (t) => {
  const file = path.join(tempDir(t), 'links.jsonl');
  const open = opener(t, file);
  const first = open();
  first.insertLink(link('one'));
  first.insertLink(link('two'));
  first.close();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[0] = lines[0].slice(0, 20);
  fs.writeFileSync(file, lines.join('\n'));
  assert.throws(
    () => open(),
    (/** @type {any} */ err) => err instanceof StorageError && err.details.line === 1 && /corrupt at line 1/.test(err.message),
  );
  // The damaged file is left untouched for inspection.
  assert.equal(fs.readFileSync(file, 'utf8'), lines.join('\n'));
  fs.writeFileSync(file, '{"op":"mystery"}\n');
  assert.throws(() => open(), StorageError);
});

test('blank lines are ignored and an empty file is a valid empty store', (t) => {
  const file = path.join(tempDir(t), 'links.jsonl');
  fs.writeFileSync(file, '');
  const open = opener(t, file);
  const empty = open();
  assert.equal(empty.countLinks(), 0);
  empty.insertLink(link('one'));
  empty.close();
  fs.appendFileSync(file, '\n\n');
  const again = open();
  assert.equal(again.countLinks(), 1);
  assert.equal(again.recovery.records, 1);
});

test('compaction shrinks the journal and preserves links, stats and the counter', (t) => {
  const file = path.join(tempDir(t), 'links.jsonl');
  const open = opener(t, file);
  const store = open();
  for (let i = 0; i < 5; i++) store.nextSequence();
  store.insertLink(link('busy'));
  store.insertLink(link('idle'));
  store.insertLink(link('temp'));
  for (let i = 0; i < 40; i++) store.recordClick(click('busy', T0 + i, `v${i % 4}`));
  store.updateLink('idle', { url: 'https://example.com/changed' });
  store.deleteLink('temp');
  const before = { busy: store.getLink('busy'), idle: store.getLink('idle'), stats: store.getStats('busy') };

  const result = store.compact();
  assert.equal(result.recordsBefore, 50);
  assert.equal(result.recordsAfter, 4);
  assert.ok(result.bytesAfter < result.bytesBefore);
  assert.equal(fs.statSync(file).size, result.bytesAfter);
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  // The store keeps working on the new file after compaction.
  store.recordClick(click('busy', T0 + 100, 'v9'));
  assert.equal(store.journalRecords, 5);
  store.close();

  const reopened = open();
  assert.deepEqual(reopened.getLink('idle'), before.idle);
  assert.equal(reopened.getLink('busy')?.clicks, 41);
  assert.equal(reopened.getStats('busy')?.total, 41);
  assert.equal(reopened.getStats('busy')?.days['2026-06-01'].visitors.length, 5);
  assert.equal(reopened.hasLink('temp'), false);
  assert.equal(reopened.nextSequence(), 5);
});

test('a leftover compaction temp file is discarded on open', (t) => {
  const file = path.join(tempDir(t), 'links.jsonl');
  const open = opener(t, file);
  const first = open();
  first.insertLink(link('one'));
  first.close();
  fs.writeFileSync(`${file}.tmp`, '{"op":"put","link":');
  const second = open();
  assert.equal(second.countLinks(), 1);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('a closed store refuses writes; an unusable path is a StorageError', (t) => {
  const dir = tempDir(t);
  const store = opener(t, path.join(dir, 'links.jsonl'))();
  store.close();
  assert.throws(() => store.insertLink(link('late')), StorageError);
  assert.throws(() => store.compact(), StorageError);
  assert.equal(store.hasLink('late'), false);
  // A directory cannot be opened as a journal.
  assert.throws(() => FileStore.open(dir), StorageError);
});
