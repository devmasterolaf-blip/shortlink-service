import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHost, normalizeUrl, selfHostOf } from '../src/url/validate.js';
import { ValidationError } from '../src/errors.js';

/** @param {() => unknown} fn @param {string} code */
function assertRejects(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ValidationError, String(err));
    assert.equal(err.code, code);
    assert.equal(err.field, 'url');
    return true;
  });
}

test('normalises scheme, host case, default port and dot segments', () => {
  assert.equal(normalizeUrl('HTTP://Example.COM:80/a/../b?x=1#frag').url, 'http://example.com/b?x=1#frag');
  assert.equal(normalizeUrl('https://example.com:443').url, 'https://example.com/');
  assert.equal(normalizeUrl('  https://example.com/path  ').url, 'https://example.com/path');
  assert.equal(normalizeUrl('https://example.com:8443/').url, 'https://example.com:8443/');
});

test('rejects values that are not absolute URLs', () => {
  assertRejects(() => normalizeUrl(undefined), 'url_invalid');
  assertRejects(() => normalizeUrl(''), 'url_invalid');
  assertRejects(() => normalizeUrl('   '), 'url_invalid');
  assertRejects(() => normalizeUrl('example.com/page'), 'url_invalid');
  assertRejects(() => normalizeUrl('/relative/path'), 'url_invalid');
  assertRejects(() => normalizeUrl('http://'), 'url_invalid');
  assertRejects(() => normalizeUrl('https://exa mple.com/'), 'url_invalid');
  assertRejects(() => normalizeUrl('https://example.com/a\nb'), 'url_invalid');
});

test('enforces the scheme allow-list', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/hosts', 'ftp://example.com/f']) {
    assertRejects(() => normalizeUrl(url), 'url_scheme_not_allowed');
  }
  assert.equal(
    normalizeUrl('ftp://example.com/f', { allowedSchemes: ['https', 'ftp'] }).url,
    'ftp://example.com/f',
  );
  assertRejects(() => normalizeUrl('http://example.com/', { allowedSchemes: ['https'] }), 'url_scheme_not_allowed');
});

test('enforces the length limit before and after normalisation', () => {
  const long = `https://example.com/${'a'.repeat(2048)}`;
  assertRejects(() => normalizeUrl(long), 'url_too_long');
  assert.ok(normalizeUrl(long, { maxLength: 4096 }).url.length > 2048);
  // 20 input characters grow to a longer percent-encoded URL.
  assertRejects(() => normalizeUrl('https://e.com/ééééé', { maxLength: 25 }), 'url_too_long');
});

test('rejects embedded credentials unless allowed', () => {
  assertRejects(() => normalizeUrl('https://user:pw@example.com/'), 'url_credentials_not_allowed');
  assertRejects(() => normalizeUrl('https://user@example.com/'), 'url_credentials_not_allowed');
  assert.equal(
    normalizeUrl('https://user:pw@example.com/', { allowCredentials: true }).url,
    'https://user:pw@example.com/',
  );
});

test('converts internationalised hosts to punycode and keeps a display form', () => {
  const result = normalizeUrl('https://bücher.example/straße');
  assert.equal(result.host, 'xn--bcher-kva.example');
  assert.equal(result.unicodeHost, 'bücher.example');
  assert.equal(result.url, 'https://xn--bcher-kva.example/stra%C3%9Fe');
});

test('classifyHost recognises non-public IPv4 ranges', () => {
  const cases = {
    '127.0.0.1': 'loopback',
    '127.255.255.254': 'loopback',
    '10.1.2.3': 'private',
    '172.16.0.1': 'private',
    '172.31.255.255': 'private',
    '172.32.0.1': 'public',
    '192.168.1.1': 'private',
    '100.64.0.1': 'private',
    '169.254.169.254': 'link-local',
    '0.0.0.0': 'unspecified',
    '224.0.0.1': 'reserved',
    '8.8.8.8': 'public',
    '1.1.1.1': 'public',
  };
  for (const [host, expected] of Object.entries(cases)) {
    assert.equal(classifyHost(host), expected, host);
  }
});

test('classifyHost recognises non-public IPv6 ranges', () => {
  const cases = {
    '[::1]': 'loopback',
    '[::]': 'unspecified',
    '[fc00::1]': 'private',
    '[fd12:3456:789a::1]': 'private',
    '[fe80::1]': 'link-local',
    '[ff02::1]': 'reserved',
    '[::ffff:7f00:1]': 'loopback',
    '[::ffff:c0a8:101]': 'private',
    '[64:ff9b::a00:1]': 'private',
    '[2001:4860:4860::8888]': 'public',
  };
  for (const [host, expected] of Object.entries(cases)) {
    assert.equal(classifyHost(host), expected, host);
  }
});

test('classifyHost recognises local names', () => {
  assert.equal(classifyHost('localhost'), 'loopback');
  assert.equal(classifyHost('app.localhost'), 'loopback');
  assert.equal(classifyHost('printer.local'), 'private');
  assert.equal(classifyHost('db.internal'), 'private');
  assert.equal(classifyHost('intranet'), 'private');
  assert.equal(classifyHost('localhost.example.com'), 'public');
});

test('blockPrivateHosts sees through obfuscated loopback spellings', () => {
  const policy = { blockPrivateHosts: true };
  const blocked = [
    'http://localhost/',
    'http://LOCALHOST./',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://017700000001/',
    'http://127.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://192.168.0.10:8080/admin',
    'http://169.254.169.254/latest/meta-data/',
  ];
  for (const url of blocked) {
    assertRejects(() => normalizeUrl(url, policy), 'url_host_not_allowed');
  }
  assert.equal(normalizeUrl('http://93.184.216.34/', policy).url, 'http://93.184.216.34/');
  assert.equal(normalizeUrl('http://127.0.0.1/').url, 'http://127.0.0.1/');
});

test('rejects links that point back at the service itself', () => {
  const policy = { selfHosts: [selfHostOf('https://sho.rt'), selfHostOf('http://localhost:8080')] };
  assert.deepEqual(policy.selfHosts, ['sho.rt', 'localhost:8080']);
  assertRejects(() => normalizeUrl('https://sho.rt/abc', policy), 'url_self_reference');
  assertRejects(() => normalizeUrl('http://SHO.RT./abc', policy), 'url_self_reference');
  assertRejects(() => normalizeUrl('http://localhost:8080/x', policy), 'url_self_reference');
  assert.equal(normalizeUrl('http://localhost:9090/x', policy).url, 'http://localhost:9090/x');
  assert.equal(normalizeUrl('https://sub.sho.rt/abc', policy).url, 'https://sub.sho.rt/abc');
});
