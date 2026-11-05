import test from 'node:test';
import assert from 'node:assert/strict';
import { referrerSource, userAgentFamily } from '../src/analytics/classify.js';
import { VisitorHasher, normalizeIp } from '../src/analytics/visitors.js';

test('userAgentFamily tells apart browsers that share tokens', () => {
  const cases = {
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36': 'Chrome',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0': 'Edge',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0': 'Opera',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15': 'Safari',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0': 'Firefox',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1': 'Chrome',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)': 'Bot',
    'curl/8.5.0': 'curl',
    'Wget/1.21.4': 'Wget',
    'SomeHttpClient/1.0': 'Other',
    '': 'Unknown',
  };
  for (const [ua, expected] of Object.entries(cases)) {
    assert.equal(userAgentFamily(ua), expected, ua);
  }
  assert.equal(userAgentFamily(undefined), 'Unknown');
});

test('referrerSource keeps only the host', () => {
  assert.equal(referrerSource('https://www.Example.com/some/page?q=secret'), 'example.com');
  assert.equal(referrerSource('http://news.example.org:8080/'), 'news.example.org');
  assert.equal(referrerSource(undefined), '(direct)');
  assert.equal(referrerSource('  '), '(direct)');
  assert.equal(referrerSource('not a url'), '(unknown)');
  assert.equal(referrerSource('android-app://com.example.app'), '(unknown)');
});

test('visitor hash is stable within a day and rotates at UTC midnight', () => {
  const hasher = new VisitorHasher({ secret: 'test-secret' });
  const morning = Date.parse('2026-05-01T08:00:00Z');
  const evening = Date.parse('2026-05-01T23:59:59Z');
  const nextDay = Date.parse('2026-05-02T00:00:00Z');
  const a = hasher.hash('203.0.113.7', morning);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(hasher.hash('203.0.113.7', evening), a);
  assert.notEqual(hasher.hash('203.0.113.7', nextDay), a);
  assert.notEqual(hasher.hash('203.0.113.8', morning), a);
});

test('visitor hash depends on the secret and never contains the address', () => {
  const at = Date.parse('2026-05-01T08:00:00Z');
  const one = new VisitorHasher({ secret: 'one' }).hash('203.0.113.7', at);
  const two = new VisitorHasher({ secret: 'two' }).hash('203.0.113.7', at);
  assert.notEqual(one, two);
  assert.equal(new VisitorHasher({ secret: 'one' }).hash('203.0.113.7', at), one);
  assert.notEqual(new VisitorHasher().hash('203.0.113.7', at), new VisitorHasher().hash('203.0.113.7', at));
  assert.ok(!one.includes('203'));
});

test('IPv4-mapped IPv6 addresses hash like plain IPv4', () => {
  const hasher = new VisitorHasher({ secret: 's' });
  assert.equal(normalizeIp('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeIp(' 2001:DB8::1 '), '2001:db8::1');
  assert.equal(hasher.hash('::ffff:192.0.2.1', 0), hasher.hash('192.0.2.1', 0));
});
