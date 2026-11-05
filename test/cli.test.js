import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ManualClock } from '../src/clock.js';
import { run } from '../src/cli/cli.js';
import { FileStore } from '../src/storage/fileStore.js';
import { T0 } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * A CLI bound to one data file, capturing its output.
 * @param {import('node:test').TestContext} t
 */
function cli(t) {
  const dir = tempDir(t);
  const dataFile = path.join(dir, 'links.jsonl');
  const clock = new ManualClock(T0);
  const env = { SHORTLINK_BASE_URL: 'https://sho.rt', SHORTLINK_FSYNC: 'never' };
  /** @param {...string} args */
  const invoke = async (...args) => {
    let out = '';
    let err = '';
    const code = await run(['--data-file', dataFile, ...args], {
      env,
      clock,
      stdout: (text) => void (out += text),
      stderr: (text) => void (err += text),
    });
    return { code, out, err };
  };
  return { invoke, dir, dataFile, clock, env };
}

test('create prints the short URL and the link persists', async (t) => {
  const { invoke, dataFile } = cli(t);
  const created = await invoke('create', 'https://example.com/landing', '--alias', 'promo', '--tag', 'ads', '--tag', 'q3');
  assert.deepEqual(created, { code: 0, out: 'https://sho.rt/promo\n', err: '' });
  const generated = await invoke('create', 'https://example.com/other', '--json', '--ttl', '3600', '--max-clicks', '10', '--redirect', '301', '--disabled');
  assert.equal(generated.code, 0);
  const link = JSON.parse(generated.out);
  assert.equal(link.expiresAt, '2026-06-01T13:00:00.000Z');
  assert.deepEqual([link.maxClicks, link.redirectType, link.enabled, link.custom], [10, 301, false, false]);

  const store = FileStore.open(dataFile);
  t.after(() => store.close());
  assert.deepEqual(store.getLink('promo')?.tags, ['ads', 'q3']);
  assert.equal(store.countLinks(), 2);
});

test('validation errors exit with 1 and a one-line message', async (t) => {
  const { invoke } = cli(t);
  await invoke('create', 'https://example.com/', '--alias', 'promo');
  const duplicate = await invoke('create', 'https://example.com/', '--alias', 'promo');
  assert.deepEqual(duplicate, { code: 1, out: '', err: 'shortlink: Alias "promo" is already in use\n' });
  assert.equal((await invoke('create', 'javascript:alert(1)')).code, 1);
  assert.equal((await invoke('stats', 'missing')).code, 1);
  assert.match((await invoke('create', 'https://example.com/', '--password', 'abc')).err, /password must be 4 to 128/);
});

test('usage errors exit with 2', async (t) => {
  const { invoke, env } = cli(t);
  for (const args of [
    ['frobnicate'],
    ['create'],
    ['create', 'https://a.example/', 'https://b.example/'],
    ['create', 'https://a.example/', '--ttl', 'soon'],
    ['list', '--alias', 'x'],
    ['list', '--no-such-flag'],
    ['export', '--format', 'xml'],
  ]) {
    const result = await invoke(...args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.err, /^shortlink: .+\nRun "shortlink help" for usage\.\n$/);
  }
  let err = '';
  assert.equal(await run(['list'], { env, stdout: () => {}, stderr: (text) => void (err += text) }), 2);
  assert.match(err, /pass --data-file or set SHORTLINK_STORE=file/);
});

test('help and version need no data file', async () => {
  let out = '';
  const io = { env: {}, stdout: (/** @type {string} */ text) => void (out += text), stderr: () => {} };
  assert.equal(await run(['help'], io), 0);
  assert.match(out, /^Usage: shortlink <command>/);
  assert.equal(await run(['--help'], io), 0);
  assert.equal(await run([], io), 2);
  out = '';
  assert.equal(await run(['--version'], io), 0);
  assert.match(out, /^\d+\.\d+\.\d+\n$/);
});

test('list prints a table, filters, and supports JSON output', async (t) => {
  const { invoke, clock } = cli(t);
  await invoke('create', 'https://example.com/a', '--alias', 'aaa', '--tag', 'x');
  clock.advance(1000);
  await invoke('create', 'https://example.com/b', '--alias', 'bbb', '--ttl', '60');
  const table = await invoke('list', '--sort', 'code');
  assert.equal(
    table.out,
    [
      'CODE  STATUS  CLICKS  EXPIRES                   URL',
      'aaa   active  0       -                         https://example.com/a',
      'bbb   active  0       2026-06-01T12:01:01.000Z  https://example.com/b',
      '',
      'page 1 of 1, 2 link(s)',
      '',
    ].join('\n'),
  );
  clock.advance(120_000);
  const expired = JSON.parse((await invoke('list', '--status', 'expired', '--json')).out);
  assert.deepEqual(expired.items.map((/** @type {any} */ link) => link.code), ['bbb']);
  const tagged = JSON.parse((await invoke('list', '--tag', 'x', '--json', '--page-size', '1')).out);
  assert.deepEqual([tagged.total, tagged.items[0].code], [1, 'aaa']);
  assert.equal((await invoke('list', '--page', '0')).code, 1);
});

test('stats shows the report for clicks recorded in the data file', async (t) => {
  const { invoke, dataFile } = cli(t);
  await invoke('create', 'https://example.com/', '--alias', 'seen');
  const store = FileStore.open(dataFile, { fsync: 'never' });
  store.recordClick({ code: 'seen', at: T0, referrer: 'news.example', userAgent: 'Firefox', visitor: 'v1' });
  store.recordClick({ code: 'seen', at: T0 + 1, referrer: 'news.example', userAgent: 'Chrome', visitor: 'v2' });
  store.close();

  const text = await invoke('stats', 'seen');
  assert.equal(text.code, 0);
  assert.match(text.out, /total clicks: {4}2\n/);
  assert.match(text.out, /unique visitors: 2\n/);
  assert.match(text.out, /per day:\n {2}2026-06-01 {2}2 clicks, 2 visitors\n/);
  assert.match(text.out, /referrers:\n {2}news\.example {2}2\n/);
  const json = JSON.parse((await invoke('stats', 'seen', '--json', '--from', '2026-06-02')).out);
  assert.deepEqual([json.totalClicks, json.clicksInRange], [2, 0]);
});

test('export and import round-trip through files in both formats', async (t) => {
  const source = cli(t);
  await source.invoke('create', 'https://example.com/a', '--alias', 'aaa', '--password', 'letmein', '--tag', 'x');
  await source.invoke('create', 'https://example.com/b,c', '--alias', 'bbb');
  const csvFile = path.join(source.dir, 'links.csv');
  const jsonFile = path.join(source.dir, 'links.json');
  assert.deepEqual(await source.invoke('export', '--output', csvFile), { code: 0, out: '', err: '' });
  assert.equal((await source.invoke('export', '--output', jsonFile)).code, 0);
  if (process.platform !== 'win32') assert.equal(fs.statSync(csvFile).mode & 0o777, 0o600);
  const toStdout = await source.invoke('export', '--format', 'csv');
  assert.equal(toStdout.out, fs.readFileSync(csvFile, 'utf8'));

  const fromCsv = cli(t);
  const dry = await fromCsv.invoke('import', csvFile, '--dry-run');
  assert.equal(dry.out, 'dry run: 2 created, 0 overwritten, 0 skipped, 0 failed\n');
  assert.equal((await fromCsv.invoke('import', csvFile)).out, '2 created, 0 overwritten, 0 skipped, 0 failed\n');
  assert.equal((await fromCsv.invoke('import', jsonFile)).out, '0 created, 0 overwritten, 2 skipped, 0 failed\n');
  assert.equal((await fromCsv.invoke('import', jsonFile, '--on-conflict', 'overwrite')).out, '0 created, 2 overwritten, 0 skipped, 0 failed\n');
  const listed = JSON.parse((await fromCsv.invoke('list', '--json', '--sort', 'code')).out);
  assert.deepEqual(listed.items.map((/** @type {any} */ link) => [link.code, link.url, link.hasPassword]), [
    ['aaa', 'https://example.com/a', true],
    ['bbb', 'https://example.com/b,c', false],
  ]);
});

test('import reports bad records on stderr and exits with 1', async (t) => {
  const { invoke, dir } = cli(t);
  const file = path.join(dir, 'in.json');
  fs.writeFileSync(file, JSON.stringify([{ url: 'https://example.com/ok', code: 'fine' }, { url: 'nope' }]));
  const result = await invoke('import', file);
  assert.equal(result.code, 1);
  assert.equal(result.out, '1 created, 0 overwritten, 0 skipped, 1 failed\n');
  assert.match(result.err, /^record 2: /);
  const strict = await invoke('import', file, '--on-conflict', 'error', '--json');
  assert.equal(JSON.parse(strict.out).errors[0].error.code, 'code_taken');
  assert.deepEqual(await invoke('import', path.join(dir, 'absent.json')).then((r) => [r.code, /Cannot read/.test(r.err)]), [1, true]);
  assert.equal((await invoke('import', file, '--on-conflict', 'merge')).code, 1);
});

test('compact rewrites the data file', async (t) => {
  const { invoke, dataFile } = cli(t);
  await invoke('create', 'https://example.com/', '--alias', 'aaa');
  await invoke('create', 'https://example.com/', '--alias', 'bbb');
  const store = FileStore.open(dataFile, { fsync: 'never' });
  store.deleteLink('bbb');
  store.close();
  const before = fs.statSync(dataFile).size;
  const result = await invoke('compact');
  assert.match(result.out, /^compacted: 3 -> 2 records, \d+ -> \d+ bytes\n$/);
  assert.ok(fs.statSync(dataFile).size < before);
  assert.equal(JSON.parse((await invoke('list', '--json')).out).total, 1);
});

test('configuration problems are reported, not thrown', async (t) => {
  const { dataFile } = cli(t);
  let err = '';
  const code = await run(['list', '--data-file', dataFile], {
    env: { SHORTLINK_CODE_LENGTH: '99' },
    stdout: () => {},
    stderr: (text) => void (err += text),
  });
  assert.equal(code, 1);
  assert.match(err, /^shortlink: Invalid configuration:\n- SHORTLINK_CODE_LENGTH/);
});
