import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

/** @param {Record<string, string>} env */
function problemsOf(env) {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
  return assert.fail('expected a ConfigError');
}

test('defaults when nothing is set', () => {
  const config = loadConfig({ PATH: '/usr/bin', HOME: '/root' });
  assert.equal(config.port, 8080);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.baseUrl, 'http://localhost:8080');
  assert.equal(config.store, 'memory');
  assert.equal(config.fsync, 'always');
  assert.equal(config.codeStrategy, 'counter');
  assert.equal(config.codeLength, 5);
  assert.deepEqual(config.apiKeys, []);
  assert.deepEqual(config.allowedSchemes, ['http', 'https']);
  assert.equal(config.blockPrivateHosts, false);
  assert.equal(config.defaultRedirect, 302);
  assert.equal(config.rateLimitRefillPerSec, 1);
  assert.equal(config.visitorSecret, undefined);
});

test('every setting can be overridden', () => {
  const config = loadConfig({
    SHORTLINK_PORT: '9000',
    SHORTLINK_HOST: '0.0.0.0',
    SHORTLINK_BASE_URL: 'https://Sho.RT/',
    SHORTLINK_STORE: 'file',
    SHORTLINK_DATA_FILE: 'var/links.jsonl',
    SHORTLINK_FSYNC: 'never',
    SHORTLINK_CODE_STRATEGY: 'RANDOM',
    SHORTLINK_API_KEYS: 'ops:0123456789abcdef0123:*',
    SHORTLINK_RATE_LIMIT_CAPACITY: '10',
    SHORTLINK_RATE_LIMIT_REFILL_PER_SEC: '0.5',
    SHORTLINK_ALLOWED_SCHEMES: 'https, MAILTO:',
    SHORTLINK_BLOCK_PRIVATE_HOSTS: 'yes',
    SHORTLINK_DEFAULT_REDIRECT: '307',
    SHORTLINK_TRUST_PROXY: '1',
    SHORTLINK_VISITOR_SECRET: 'a-long-enough-visitor-secret',
    SHORTLINK_LOG_LEVEL: 'silent',
  });
  assert.equal(config.port, 9000);
  assert.equal(config.baseUrl, 'https://sho.rt');
  assert.equal(config.store, 'file');
  assert.equal(config.dataFile, 'var/links.jsonl');
  assert.equal(config.fsync, 'never');
  assert.equal(config.codeStrategy, 'random');
  assert.equal(config.codeLength, 7);
  assert.equal(config.apiKeys[0].name, 'ops');
  assert.equal(config.rateLimitRefillPerSec, 0.5);
  assert.deepEqual(config.allowedSchemes, ['https', 'mailto']);
  assert.equal(config.blockPrivateHosts, true);
  assert.equal(config.defaultRedirect, 307);
  assert.equal(config.trustProxy, true);
  assert.equal(config.logLevel, 'silent');
});

test('the default base URL follows the port; empty values count as unset', () => {
  assert.equal(loadConfig({ SHORTLINK_PORT: '3000' }).baseUrl, 'http://localhost:3000');
  assert.equal(loadConfig({ SHORTLINK_PORT: '  ', SHORTLINK_STORE: '' }).port, 8080);
});

test('all problems are reported together', () => {
  const problems = problemsOf({
    SHORTLINK_PORT: '70000',
    SHORTLINK_STORE: 'redis',
    SHORTLINK_BASE_URL: 'https://sho.rt/go',
    SHORTLINK_API_KEYS: 'ops:short:*',
    SHORTLINK_TRUST_PROXY: 'maybe',
    SHORTLINK_CODE_LENGHT: '6',
  });
  assert.equal(problems.length, 6);
  assert.match(problems.join('\n'), /SHORTLINK_PORT must be an integer between 0 and 65535 \(got "70000"\)/);
  assert.match(problems.join('\n'), /SHORTLINK_STORE must be one of: memory, file \(got "redis"\)/);
  assert.match(problems.join('\n'), /SHORTLINK_BASE_URL must be a bare origin/);
  assert.match(problems.join('\n'), /SHORTLINK_API_KEYS is invalid: .*at least 16 characters/);
  assert.match(problems.join('\n'), /SHORTLINK_TRUST_PROXY must be true or false/);
  assert.match(problems.join('\n'), /SHORTLINK_CODE_LENGHT is not a known setting/);
});

test('numbers are parsed strictly', () => {
  for (const value of ['12abc', '-1', '1e3', '0x10', '80.5']) {
    assert.match(problemsOf({ SHORTLINK_PORT: value })[0], /SHORTLINK_PORT must be an integer/, value);
  }
  assert.match(problemsOf({ SHORTLINK_RATE_LIMIT_REFILL_PER_SEC: '0' })[0], /must be a number between 0.001 and 100000/);
  assert.match(problemsOf({ SHORTLINK_CODE_LENGTH: '3' })[0], /between 4 and 12/);
});

test('base URL, schemes and visitor secret are checked', () => {
  assert.match(problemsOf({ SHORTLINK_BASE_URL: 'sho.rt' })[0], /must be an absolute URL/);
  assert.match(problemsOf({ SHORTLINK_BASE_URL: 'ftp://sho.rt' })[0], /must use http or https/);
  assert.match(problemsOf({ SHORTLINK_BASE_URL: 'https://user@sho.rt' })[0], /bare origin/);
  assert.match(problemsOf({ SHORTLINK_ALLOWED_SCHEMES: 'https,java script' })[0], /invalid scheme "java script"/);
  assert.match(problemsOf({ SHORTLINK_ALLOWED_SCHEMES: ' , ' })[0], /at least one scheme/);
  assert.match(problemsOf({ SHORTLINK_VISITOR_SECRET: 'short' })[0], /at least 16 characters/);
});

test('the error message lists each problem on its own line', () => {
  assert.throws(
    () => loadConfig({ SHORTLINK_PORT: 'x', SHORTLINK_FSYNC: 'sometimes' }),
    (/** @type {any} */ err) => err.message.split('\n').length === 3 && err.message.startsWith('Invalid configuration:\n- SHORTLINK_PORT'),
  );
});
