import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_MODEL_REQUEST_RETRIES, MAX_RETRY_AFTER_MS, parseRetryAfter, retryDelay, waitForRetry,
} from '../src/retry.ts';

test('Retry-After accepts seconds and HTTP dates without treating junk as a date', () => {
  const now = Date.parse('Sun, 20 Sep 2026 09:00:00 GMT');
  assert.equal(parseRetryAfter('0', now), 0);
  assert.equal(parseRetryAfter(' 12 ', now), 12_000);
  assert.equal(parseRetryAfter('Sun, 20 Sep 2026 09:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('Sunday, 20-Sep-26 09:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('Sun Sep 20 09:00:30 2026', now), 30_000);
  assert.equal(parseRetryAfter('Sun, 20 Sep 2026 08:59:59 GMT', now), 0);
  for (const value of [null, '', '-1', '1.5', 'NaN', 'Infinity', 'tomorrow', 'Sun nope']) {
    assert.equal(parseRetryAfter(value, now), undefined, String(value));
  }
});

test('backoff is exponential and stops after five additional attempts', () => {
  assert.equal(MAX_MODEL_REQUEST_RETRIES, 5);
  assert.deepEqual(Array.from({ length: 5 }, (_, attempt) => retryDelay(attempt)), [250, 500, 1000, 2000, 4000]);
  assert.equal(retryDelay(5), undefined);
  assert.equal(retryDelay(6, 0), undefined);
  assert.equal(retryDelay(0, 0), 0);
  assert.equal(retryDelay(0, 30_000), 30_000);
  assert.equal(retryDelay(0, MAX_RETRY_AFTER_MS), MAX_RETRY_AFTER_MS);
});

test('long/overflowing Retry-After never becomes an early retry', () => {
  assert.equal(retryDelay(0, parseRetryAfter('61')), undefined);
  assert.equal(retryDelay(0, parseRetryAfter('9999999999999999999999999999999999')), undefined);
  assert.equal(retryDelay(0, parseRetryAfter('9'.repeat(400))), undefined);
});

test('an already aborted signal rejects even a zero-delay retry', async () => {
  const controller = new AbortController();
  controller.abort(new Error('user cancelled'));
  await assert.rejects(waitForRetry(0, controller.signal), /user cancelled/);
});

test('cancellation interrupts the waiting period', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  const waiting = waitForRetry(60_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});

test('an ordinary zero-delay wait completes', async () => {
  await waitForRetry(0);
});
