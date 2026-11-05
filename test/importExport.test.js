import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/io/csv.js';
import { EXPORT_FIELDS, exportCsv, exportJson, importLinks, parseImport } from '../src/io/importExport.js';
import { hashPassword } from '../src/security/password.js';
import { DAY, FAST_COST, T0, expectError, makeService } from './helpers.js';
import { KEYS, startApp } from './httpHelpers.js';

async function seeded() {
  const context = makeService();
  const { service, clock } = context;
  await service.createLink({ url: 'https://example.com/a', alias: 'alpha', tags: ['x', 'y'], maxClicks: 5 });
  clock.advance(1000);
  await service.createLink({ url: 'https://example.com/b?q=1,2', alias: 'beta', password: 'hunter22', redirectType: 301 });
  await service.createLink({ url: 'https://example.com/c', expiresAt: clock.now() + DAY });
  await service.resolve('alpha', {});
  return context;
}

test('JSON export is a versioned document that restores into an empty store', async () => {
  const source = await seeded();
  const text = exportJson(source.store, source.clock.now());
  const document = JSON.parse(text);
  assert.equal(document.version, 1);
  assert.equal(document.exportedAt, '2026-06-01T12:00:01.000Z');
  assert.equal(document.links.length, 3);
  assert.deepEqual(Object.keys(document.links[0]), [...EXPORT_FIELDS]);

  const target = makeService();
  const summary = await importLinks(target.service, parseImport(text, 'json'));
  assert.deepEqual(summary, { total: 3, created: 3, overwritten: 0, skipped: 0, failed: 0, dryRun: false, errors: [] });
  assert.deepEqual(target.store.listLinks(), source.store.listLinks());
  // The restored hash still accepts the original password.
  assert.equal((await target.service.resolve('beta', { password: 'hunter22' })).status, 301);
});

test('CSV export round-trips, including quoted cells, tags and empty values', async () => {
  const source = await seeded();
  const text = exportCsv(source.store);
  const rows = parseCsv(text);
  assert.deepEqual(rows[0], [...EXPORT_FIELDS]);
  assert.equal(rows.length, 4);
  assert.match(text, /"https:\/\/example\.com\/b\?q=1,2"/);
  assert.match(text, /,x\|y,/);

  const target = makeService();
  const summary = await importLinks(target.service, parseImport(text, 'csv'));
  assert.equal(summary.created, 3);
  assert.deepEqual(target.store.listLinks(), source.store.listLinks());
});

test('import validates each record and keeps going', async () => {
  const { service, store } = makeService();
  const summary = await importLinks(service, [
    { url: 'https://example.com/ok', code: 'fine' },
    { url: 'ftp://example.com/' },
    { url: 'https://example.com/', code: 'api' },
    { url: 'https://example.com/', clicks: -1 },
    { url: 'https://example.com/', colour: 'red' },
    'not an object',
    { url: 'https://example.com/', passwordHash: 'plaintext' },
    { url: 'https://example.com/', password: 'longenough', passwordHash: await hashPassword('x1234', FAST_COST) },
    { url: 'https://example.com/generated' },
  ]);
  assert.equal(summary.total, 9);
  assert.equal(summary.created, 2);
  assert.equal(summary.failed, 7);
  assert.deepEqual(
    summary.errors.map((entry) => [entry.index, entry.code, entry.error.code]),
    [
      [1, null, 'url_scheme_not_allowed'],
      [2, null, 'alias_reserved'],
      [3, null, 'validation_error'],
      [4, null, 'unknown_field'],
      [5, null, 'validation_error'],
      [6, null, 'validation_error'],
      [7, null, 'validation_error'],
    ],
  );
  assert.equal(store.countLinks(), 2);
  const generated = store.listLinks().find((link) => link.code !== 'fine');
  assert.equal(generated?.custom, false);
  assert.equal(store.getLink('fine')?.custom, true);
});

test('history is accepted on import: past timestamps and click counts', async () => {
  const { service, store } = makeService();
  const summary = await importLinks(service, [
    { url: 'https://example.com/', code: 'old', createdAt: '2020-01-01', expiresAt: '2021-01-01T00:00:00Z', clicks: 12 },
  ]);
  assert.equal(summary.created, 1);
  const link = store.getLink('old');
  assert.equal(link?.createdAt, Date.UTC(2020, 0, 1));
  assert.equal(link?.updatedAt, Date.UTC(2020, 0, 1));
  assert.equal(link?.clicks, 12);
  assert.equal(service.getLink('old').status, 'expired');
});

test('plain passwords in an import are hashed', async () => {
  const { service, store } = makeService();
  await importLinks(service, parseImport('code,url,password\nlocked,https://example.com/, pass word \n', 'csv'));
  assert.match(String(store.getLink('locked')?.passwordHash), /^scrypt\$/);
  assert.equal((await service.resolve('locked', { password: ' pass word ' })).url, 'https://example.com/');
});

test('conflict policies: skip, error and overwrite', async () => {
  const { service, store, clock } = makeService();
  await service.createLink({ url: 'https://example.com/original', alias: 'taken' });
  await service.resolve('taken', {});
  const records = [
    { url: 'https://example.com/replacement', code: 'taken', tags: ['new'] },
    { url: 'https://example.com/fresh', code: 'fresh' },
    { url: 'https://example.com/again', code: 'fresh' },
  ];

  const skipped = await importLinks(service, records);
  assert.deepEqual([skipped.created, skipped.skipped, skipped.failed], [1, 2, 0]);
  assert.equal(store.getLink('taken')?.url, 'https://example.com/original');
  assert.equal(store.getLink('fresh')?.url, 'https://example.com/fresh');

  const strict = await importLinks(service, records, { onConflict: 'error' });
  assert.deepEqual([strict.created, strict.failed], [0, 3]);
  assert.deepEqual(strict.errors[0], { index: 0, code: 'taken', error: { code: 'code_taken', message: 'Code "taken" is already in use' } });

  clock.advance(5000);
  const forced = await importLinks(service, records, { onConflict: 'overwrite' });
  assert.deepEqual([forced.created, forced.overwritten], [0, 3]);
  assert.equal(store.getLink('taken')?.url, 'https://example.com/replacement');
  assert.deepEqual(store.getLink('taken')?.tags, ['new']);
  assert.equal(store.getLink('fresh')?.url, 'https://example.com/again');
  // The click history of an overwritten link stays attached to the code.
  assert.equal(store.getStats('taken')?.total, 1);
  await assert.rejects(importLinks(service, [], { onConflict: /** @type {any} */ ('merge') }), /onConflict must be one of/);
});

test('a dry run reports what would happen without writing or using up codes', async () => {
  const { service, store } = makeService();
  await service.createLink({ url: 'https://example.com/', alias: 'here' });
  const summary = await importLinks(
    service,
    [
      { url: 'https://example.com/1', code: 'here' },
      { url: 'https://example.com/2', code: 'twice' },
      { url: 'https://example.com/3', code: 'twice' },
      { url: 'https://example.com/4' },
      { url: 'nope' },
    ],
    { dryRun: true },
  );
  assert.deepEqual(
    [summary.created, summary.skipped, summary.failed, summary.dryRun],
    [2, 2, 1, true],
  );
  assert.equal(store.countLinks(), 1);
  assert.equal(store.nextSequence(), 0);
});

test('import documents are checked before any record is read', () => {
  expectError(() => parseImport('{"links": 5}', 'json'), 'import_invalid', 400);
  expectError(() => parseImport('[', 'json'), 'invalid_json', 400);
  expectError(() => parseImport('code,link\na,b\n', 'csv'), 'unknown_field', 400);
  expectError(() => parseImport('code,tags\na,b\n', 'csv'), 'csv_invalid', 400);
  assert.deepEqual(parseImport('[]', 'json'), []);
  assert.deepEqual(parseImport('url,maxClicks,enabled,tags,redirectType\nhttps://e.example/,7,FALSE,a| b |,301\n', 'csv'), [
    { url: 'https://e.example/', maxClicks: 7, enabled: false, tags: ['a', 'b'], redirectType: 301 },
  ]);
});

test('export and import over HTTP need the admin scope', async (t) => {
  const { api } = await startApp(t);
  await api('POST', '/api/links', { body: { url: 'https://example.com/a', alias: 'alpha' } });
  assert.equal((await api('GET', '/api/export', { key: KEYS.writer })).status, 403);
  assert.equal((await api('POST', '/api/import', { key: KEYS.writer, body: [] })).status, 403);

  const json = await api('GET', '/api/export');
  assert.equal(json.status, 200);
  assert.equal(json.headers.get('content-disposition'), 'attachment; filename="links.json"');
  assert.equal(json.json.links[0].code, 'alpha');
  const csv = await api('GET', '/api/export?format=csv');
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(parseCsv(csv.text)[1][0], 'alpha');
  assert.equal((await api('GET', '/api/export?format=xml')).status, 400);
  assert.equal((await api('GET', '/api/export?fromat=csv')).json.error.code, 'unknown_field');
});

test('import over HTTP accepts JSON and CSV with conflict and dry-run options', async (t) => {
  const { api, store } = await startApp(t, { app: { maxImportBytes: 2000 } });
  const csvBody = 'code,url,tags\nfirst,https://example.com/1,a|b\nsecond,not a url,\n';
  const dry = await api('POST', '/api/import?dryRun=true', { raw: csvBody, headers: { 'Content-Type': 'text/csv' } });
  assert.equal(dry.status, 200);
  assert.deepEqual([dry.json.created, dry.json.failed, dry.json.dryRun], [1, 1, true]);
  assert.equal(store.countLinks(), 0);

  const real = await api('POST', '/api/import', { raw: csvBody, headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
  assert.deepEqual([real.json.created, real.json.failed], [1, 1]);
  assert.equal(real.json.errors[0].index, 1);
  assert.deepEqual(store.getLink('first')?.tags, ['a', 'b']);

  const overwrite = await api('POST', '/api/import?onConflict=overwrite', {
    body: { links: [{ code: 'first', url: 'https://example.com/changed' }] },
  });
  assert.equal(overwrite.json.overwritten, 1);
  assert.equal(store.getLink('first')?.url, 'https://example.com/changed');

  assert.equal((await api('POST', '/api/import?onConflict=merge', { body: [] })).status, 400);
  assert.equal((await api('POST', '/api/import?dryRun=yes', { body: [] })).status, 400);
  assert.equal((await api('POST', '/api/import', { raw: '<links/>', headers: { 'Content-Type': 'application/xml' } })).status, 415);
  assert.equal((await api('POST', '/api/import', { raw: 'code,url\n"x', headers: { 'Content-Type': 'text/csv' } })).json.error.code, 'csv_invalid');
  const big = await api('POST', '/api/import', { body: [{ url: `https://example.com/${'a'.repeat(2100)}` }] });
  assert.equal(big.status, 413);
});
