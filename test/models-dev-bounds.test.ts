import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MODELS_DEV_URL, loadModelsDev } from '../src/models-dev-cache.ts';

const raw = () => ({ lab: { models: { 'fixture-1': {
  id: 'fixture-1', name: 'Fixture 1', limit: { context: 8192, output: 1024 },
  modalities: { input: ['text'], output: ['text'] }, reasoning: false, tool_call: true,
} } } });
const response = () => new Response(JSON.stringify(raw()), { headers: { 'content-type': 'application/json' } });
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, seeded = true) {
  const directory = await mkdtemp(join(tmpdir(), 'lmm-metadata-bounds-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = join(directory, 'catalog.json');
  const original = JSON.stringify({ version: 1, source: MODELS_DEV_URL, fetchedAt: 1, data: raw() });
  if (seeded) await writeFile(cachePath, original);
  return { cachePath, original };
}

test('invalid response headers and redirects preserve the last valid cache and cancel the body', async t => {
  for (const kind of ['type', 'negative-length', 'oversized-length', 'redirect', 'url']) {
    const { cachePath, original } = await fixture(t);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(raw()))); },
      cancel() { cancelled = true; },
    });
    const headers = { 'content-type': kind === 'type' ? 'text/html' : 'application/json',
      ...(kind === 'negative-length' ? { 'content-length': '-1' } : {}),
      ...(kind === 'oversized-length' ? { 'content-length': String(32 * 1024 * 1024 + 1) } : {}) };
    const reply = new Response(body, { headers });
    if (kind === 'redirect') Object.defineProperty(reply, 'redirected', { value: true });
    if (kind === 'url') Object.defineProperty(reply, 'url', { value: 'https://other.synthetic.invalid/catalog' });
    const fetch: typeof globalThis.fetch = async (url, options) => {
      assert.equal(String(url), MODELS_DEV_URL);
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.credentials, 'omit');
      assert.deepEqual(Object.keys(options?.headers ?? {}).sort(), ['accept', 'user-agent']);
      return reply;
    };
    assert.equal((await loadModelsDev({ cachePath, force: true, fetch, now: () => 100 })).stats.models, 1, kind);
    assert.equal(cancelled, true, kind);
    assert.equal(await readFile(cachePath, 'utf8'), original, kind);
  }
});

test('a streamed catalog is stopped at 32 MiB even without Content-Length', async t => {
  const { cachePath, original } = await fixture(t);
  let pulls = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(chunk);
      if (pulls === 40) controller.close();
    },
    cancel() { cancelled = true; },
  });
  const fetch: typeof globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'application/json' } });
  assert.equal((await loadModelsDev({ cachePath, force: true, fetch, now: () => 100 })).stats.models, 1);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 34, String(pulls)); // Includes the stream's one-chunk read-ahead.
  assert.equal(await readFile(cachePath, 'utf8'), original);
});

test('a fetch implementation that ignores AbortSignal is still bounded', { timeout: 5000 }, async t => {
  const { cachePath, original } = await fixture(t);
  let signal: AbortSignal | null | undefined;
  const fetch: typeof globalThis.fetch = async (_url, options) => {
    signal = options?.signal;
    return new Promise<Response>(() => {});
  };
  assert.equal((await loadModelsDev({ cachePath, force: true, fetch, timeoutMs: 10, now: () => 100 })).stats.models, 1);
  assert.equal(signal?.aborted, true);
  assert.equal(await readFile(cachePath, 'utf8'), original);
});

test('a stalled response body is cancelled at the same request deadline', { timeout: 5000 }, async t => {
  const { cachePath, original } = await fixture(t);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const fetch: typeof globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'application/json' } });
  assert.equal((await loadModelsDev({ cachePath, force: true, fetch, timeoutMs: 10, now: () => 100 })).stats.models, 1);
  assert.equal(cancelled, true);
  assert.equal(await readFile(cachePath, 'utf8'), original);
});

test('invalid UTF-8 cannot replace previously validated public metadata', async t => {
  const { cachePath, original } = await fixture(t);
  const bytes = new TextEncoder().encode(JSON.stringify(raw()));
  bytes[2] = 0xff;
  const fetch: typeof globalThis.fetch = async () => new Response(bytes, { headers: { 'content-type': 'application/json' } });
  assert.equal((await loadModelsDev({ cachePath, force: true, fetch, now: () => 100 })).stats.models, 1);
  assert.equal(await readFile(cachePath, 'utf8'), original);
});

test('an oversized valid disk envelope is rejected before it can become a fresh cache', async t => {
  const { cachePath } = await fixture(t, false);
  const prefix = JSON.stringify({ version: 1, source: MODELS_DEV_URL, fetchedAt: 100, data: raw() });
  const size = 64 * 1024 * 1024 + 4097;
  const file = await open(cachePath, 'w');
  try {
    await file.write(prefix);
    const padding = Buffer.alloc(1024 * 1024, ' ');
    for (let written = Buffer.byteLength(prefix); written < size;) {
      const part = await file.write(padding, 0, Math.min(padding.length, size - written));
      written += part.bytesWritten;
    }
  } finally { await file.close(); }
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests++; throw new Error('offline fixture'); };
  assert.equal((await loadModelsDev({ cachePath, fetch, now: () => 101 })).stats.models, 0);
  assert.equal(requests, 1);
});

test('an explicit metadata refresh bypasses the TTL and a previous failure cooldown', async t => {
  const { cachePath } = await fixture(t, false);
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests++; return response(); };
  await loadModelsDev({ cachePath, fetch, now: () => 100 });
  await loadModelsDev({ cachePath, fetch, now: () => 101 });
  assert.equal(requests, 1);
  await loadModelsDev({ cachePath, fetch, force: true, now: () => 102 });
  assert.equal(requests, 2);
  await loadModelsDev({ cachePath, force: true, fetch: async () => { throw new Error('offline fixture'); }, now: () => 103 });
  await loadModelsDev({ cachePath, fetch, now: () => 104 });
  assert.equal(requests, 2);
  await loadModelsDev({ cachePath, fetch, force: true, now: () => 105 });
  assert.equal(requests, 3);
});

test('an already cancelled explicit refresh makes no public request', async t => {
  const { cachePath } = await fixture(t, false);
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests++; return response(); };
  await loadModelsDev({ cachePath, fetch, now: () => 100 });
  const controller = new AbortController();
  controller.abort();
  assert.equal((await loadModelsDev({ cachePath, fetch, force: true, signal: controller.signal, now: () => 101 })).stats.models, 1);
  assert.equal(requests, 1);
});
