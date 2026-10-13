import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LmmHttp, retryAfterMs } from '../src/http.ts';
import { LmmError } from '../src/protocol.ts';
import { expectedModelDeclaration } from '../src/response.ts';

test('Retry-After supports seconds and HTTP dates without treating missing headers as zero', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.equal(retryAfterMs('45', now), 45_000);
  assert.equal(retryAfterMs('Tue, 13 Oct 2026 12:00:45 GMT', now), 45_000);
  for (const value of [null, '', 'garbage', '-1']) assert.equal(retryAfterMs(value, now), undefined);
});

test('429 carries Retry-After through transport without exposing the response body', async () => {
  const http = new LmmHttp({ fetch: async () => new Response('private fixture', { status: 429, headers: { 'retry-after': '45' } }) });
  await assert.rejects(http.request('/api/status'), (error: unknown) => {
    assert.ok(error instanceof LmmError);
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.retryAfterMs, 45_000);
    assert.doesNotMatch(error.message, /private fixture/);
    return true;
  });
});

test('known alias snapshots are expected but other models and pinned snapshot changes remain visible', () => {
  assert.equal(expectedModelDeclaration('gpt-4o', 'gpt-4o-2024-08-06'), true);
  assert.equal(expectedModelDeclaration('gpt-4o', 'gpt-4o'), true);
  assert.equal(expectedModelDeclaration('gpt-4o', 'gpt-4o-mini-2024-07-18'), false);
  assert.equal(expectedModelDeclaration('gpt-4o', 'gpt-4o-2099-01-01'), false);
  assert.equal(expectedModelDeclaration('gpt-4o-2024-05-13', 'gpt-4o-2024-08-06'), false);
});
