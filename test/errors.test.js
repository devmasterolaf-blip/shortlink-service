import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  ConfigError,
  MethodNotAllowedError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitedError,
  StorageError,
  ValidationError,
  toErrorResponse,
} from '../src/errors.js';

test('typed errors carry code, status and class name', () => {
  const err = new NotFoundError('no such link');
  assert.ok(err instanceof AppError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'NotFoundError');
  assert.equal(err.code, 'not_found');
  assert.equal(err.status, 404);
});

test('ValidationError exposes the offending field in details', () => {
  const err = new ValidationError('bad url', { field: 'url' });
  assert.equal(err.status, 400);
  assert.deepEqual(err.details, { field: 'url' });
  assert.equal(new ValidationError('x').details, undefined);
});

test('toErrorResponse builds a consistent envelope', () => {
  const { status, body } = toErrorResponse(new RateLimitedError(3), 'req-1');
  assert.equal(status, 429);
  assert.deepEqual(body, {
    error: {
      code: 'rate_limited',
      message: 'Rate limit exceeded; retry in 3s',
      details: { retryAfterSeconds: 3 },
      requestId: 'req-1',
    },
  });
});

test('toErrorResponse hides internal failures', () => {
  for (const err of [new Error('db password is hunter2'), new StorageError('disk on fire'), 'boom']) {
    const { status, body } = toErrorResponse(err);
    assert.equal(status, 500);
    assert.deepEqual(body, { error: { code: 'internal_error', message: 'Internal server error' } });
  }
});

test('specialised errors keep their extra data', () => {
  assert.deepEqual(new MethodNotAllowedError(['GET', 'HEAD']).allowed, ['GET', 'HEAD']);
  assert.equal(new PayloadTooLargeError(10).limitBytes, 10);
  const cfg = new ConfigError(['a is wrong', 'b is missing']);
  assert.deepEqual(cfg.problems, ['a is wrong', 'b is missing']);
  assert.match(cfg.message, /a is wrong\n- b is missing/);
  const cause = new Error('EIO');
  assert.equal(new StorageError('write failed', { cause }).cause, cause);
});
