import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCsv, parseCsv, parseCsvRecords } from '../src/io/csv.js';
import { expectError } from './helpers.js';

test('plain rows with LF, CRLF and no final line break', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv(''), []);
});

test('quoted cells keep commas, quotes and line breaks', () => {
  const rows = parseCsv('name,note\r\n"Smith, J","said ""hi""\nthen left"\r\n');
  assert.deepEqual(rows, [['name', 'note'], ['Smith, J', 'said "hi"\nthen left']]);
});

test('empty cells, empty quoted cells and blank lines', () => {
  assert.deepEqual(parseCsv('a,,c\n,,\n'), [['a', '', 'c'], ['', '', '']]);
  assert.deepEqual(parseCsv('""\n'), [['']]);
  assert.deepEqual(parseCsv('a\n\n\nb\n'), [['a'], ['b']]);
  assert.deepEqual(parseCsv('a,\n'), [['a', '']]);
});

test('a byte-order mark is not part of the first cell', () => {
  assert.deepEqual(parseCsv('﻿code,url\n'), [['code', 'url']]);
});

test('malformed quoting is reported with the line number', () => {
  expectError(() => parseCsv('a,b\n"open,2\n3,4\n'), 'csv_invalid', 400);
  assert.throws(() => parseCsv('a,b\n"open,2\n3,4\n'), /line 2: quoted cell is never closed/);
  assert.throws(() => parseCsv('ab"c,d\n'), /line 1: unexpected quote/);
  assert.throws(() => parseCsv('x\n"a"b,c\n'), /line 2: text after a closing quote/);
});

test('formatting quotes only where needed and round-trips', () => {
  const rows = [['plain', 'with,comma', 'with "quote"', 'two\nlines', ' padded ', '']];
  const text = formatCsv(rows);
  assert.equal(text, 'plain,"with,comma","with ""quote""","two\nlines"," padded ",\r\n');
  assert.deepEqual(parseCsv(text), rows);
});

test('records are keyed by the header row', () => {
  const { columns, records } = parseCsvRecords('code, url\nabc,https://example.com/\n');
  assert.deepEqual(columns, ['code', 'url']);
  assert.deepEqual(records, [{ code: 'abc', url: 'https://example.com/' }]);
  expectError(() => parseCsvRecords(''), 'csv_invalid', 400);
  assert.throws(() => parseCsvRecords('a,a\n1,2\n'), /column "a" appears twice/);
  assert.throws(() => parseCsvRecords('a,b\n1\n'), /record 1 has 1 cells, the header has 2/);
});
