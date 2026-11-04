import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ModelMetadataCache } from '../src/models-dev-cache.ts';
import { bundledMetadata, MODELS_DEV_URL } from '../src/models-dev.ts';

const NOW = Date.parse('2026-11-04T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;

function catalog(id = 'future-model') {
  return {
    future_vendor: {
      id: 'future_vendor', name: 'Future Vendor', npm: '@ai-sdk/openai-compatible',
      models: {
        [id]: { id, name: 'Future Model', tool_call: true, reasoning: false,
          modalities: { input: ['text'], output: ['text'] }, limit: { context: 128000, output: 8000 } },
      },
    },
  };
}

function response(id = 'future-model'): Response {
  return new Response(JSON.stringify(catalog(id)), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'pi-lmm-models-dev-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('construction uses the bundled catalog without making a request', async (t) => {
  let requests = 0;
  const cache = new ModelMetadataCache({ directory: await directory(t), now: () => NOW,
    fetch: async () => { requests++; return response(); } });
  assert.equal(cache.snapshot, bundledMetadata);
  assert.equal(requests, 0);
});

test('refresh sends only a public JSON request and respects the 24 hour TTL', async (t) => {
  let now = NOW;
  const requests: Array<{ url: string; options: RequestInit | undefined }> = [];
  const cache = new ModelMetadataCache({ directory: await directory(t), now: () => now,
    fetch: async (url, options) => { requests.push({ url: String(url), options }); return response(); } });
  await cache.refresh();
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, MODELS_DEV_URL);
  assert.deepEqual(Object.keys(request.options!).sort(), ['credentials', 'headers', 'method', 'redirect', 'signal']);
  assert.equal(request.options!.method, 'GET');
  assert.equal(request.options!.redirect, 'error');
  assert.equal(request.options!.credentials, 'omit');
  assert.deepEqual(request.options!.headers, { Accept: 'application/json' });
  assert.ok(request.options!.signal instanceof AbortSignal);
  assert.equal(cache.snapshot.providers.future_vendor?.['future-model']?.contextWindow, 128000);
  assert.equal(cache.snapshot.transports?.future_vendor?.['future-model'], 'openai-completions');
  await cache.refresh();
  now += DAY - 1;
  await cache.refresh();
  assert.equal(requests.length, 1);
  now++;
  await cache.refresh();
  assert.equal(requests.length, 2);
});

test('atomically persists raw JSON and loads a verified stale cache without network', async (t) => {
  const path = await directory(t);
  const cache = new ModelMetadataCache({ directory: path, now: () => NOW, fetch: async () => response() });
  await cache.refresh();
  assert.deepEqual(await readdir(path), ['catalog-v1.json']);
  const saved = JSON.parse(await readFile(join(path, 'catalog-v1.json'), 'utf8'));
  assert.equal(saved.catalog, JSON.stringify(catalog()));
  assert.equal(saved.sourceSha256, createHash('sha256').update(saved.catalog).digest('hex'));
  let requests = 0;
  const loaded = new ModelMetadataCache({ directory: path, now: () => NOW + 2 * DAY,
    fetch: async () => { requests++; throw new Error('offline'); } });
  assert.deepEqual(loaded.snapshot, cache.snapshot);
  assert.equal(requests, 0);
  const previous = loaded.snapshot;
  await loaded.refresh();
  assert.equal(requests, 1);
  assert.equal(loaded.snapshot, previous);
});

test('rejects tampered, malformed, future-dated, and oversized disk caches', async (t) => {
  const path = await directory(t);
  const file = join(path, 'catalog-v1.json');
  const raw = JSON.stringify(catalog());
  const valid = { version: 1, fetchedAt: new Date(NOW).toISOString(),
    sourceSha256: createHash('sha256').update(raw).digest('hex'), catalog: raw };
  const invalid = [
    { ...valid, sourceSha256: '0'.repeat(64) },
    { ...valid, fetchedAt: new Date(NOW + 1).toISOString() },
    { ...valid, fetchedAt: 'invalid date' },
    { ...valid, catalog: '{}', sourceSha256: createHash('sha256').update('{}').digest('hex') },
    { ...valid, version: 2 },
    null,
  ];
  for (const item of invalid) {
    await writeFile(file, JSON.stringify(item));
    const cache = new ModelMetadataCache({ directory: path, now: () => NOW, fetch: async () => { throw new Error('unexpected network'); } });
    assert.equal(cache.snapshot, bundledMetadata);
  }
  await writeFile(file, '{broken');
  assert.equal(new ModelMetadataCache({ directory: path, now: () => NOW }).snapshot, bundledMetadata);
  await truncate(file, 2 * MAX_BYTES + 4097);
  assert.equal(new ModelMetadataCache({ directory: path, now: () => NOW }).snapshot, bundledMetadata);
});

test('failed refresh retains current metadata, retries after cooldown, and supports explicit force', async (t) => {
  let now = NOW;
  let requests = 0;
  let fail = false;
  const cache = new ModelMetadataCache({ directory: await directory(t), now: () => now,
    fetch: async () => { requests++; if (fail) throw new Error('offline'); return response(`model-${requests}`); } });
  await cache.refresh();
  const previous = cache.snapshot;
  fail = true;
  now += DAY;
  await cache.refresh();
  assert.equal(requests, 2);
  assert.equal(cache.snapshot, previous);
  now += 5 * 60 * 1000 - 1;
  await cache.refresh();
  assert.equal(requests, 2);
  now++;
  await cache.refresh();
  assert.equal(requests, 3);
  fail = false;
  await cache.refresh(undefined, true);
  assert.equal(requests, 4);
  assert.ok(cache.snapshot.providers.future_vendor?.['model-4']);
  await cache.refresh(undefined, true);
  assert.equal(requests, 5);
});

test('deduplicates concurrent normal and forced requests', async (t) => {
  let requests = 0;
  let release!: (value: Response) => void;
  const waiting = new Promise<Response>((resolve) => { release = resolve; });
  const cache = new ModelMetadataCache({ directory: await directory(t), now: () => NOW,
    fetch: async () => { requests++; return waiting; } });
  const first = cache.refresh();
  const second = cache.refresh();
  const forced = cache.refresh(undefined, true);
  assert.equal(requests, 1);
  release(response());
  await Promise.all([first, second, forced]);
  assert.ok(cache.snapshot.providers.future_vendor?.['future-model']);
});

test('invalid HTTP, content type, JSON, and metadata do not replace verified data', async (t) => {
  const invalid = [
    () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
    () => new Response(JSON.stringify(catalog()), { headers: { 'content-type': 'text/html' } }),
    () => new Response('{bad', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    () => new Response(Uint8Array.of(0xff), { headers: { 'content-type': 'application/json' } }),
    () => { const result = response(); Object.defineProperty(result, 'redirected', { value: true }); return result; },
    () => { const result = response(); Object.defineProperty(result, 'url', { value: 'https://other.example/catalog' }); return result; },
  ];
  let makeResponse = () => response();
  const path = await directory(t);
  const cache = new ModelMetadataCache({ directory: path, now: () => NOW, fetch: async () => makeResponse() });
  await cache.refresh();
  const previous = cache.snapshot;
  const saved = await readFile(join(path, 'catalog-v1.json'), 'utf8');
  for (const make of invalid) {
    makeResponse = make;
    await cache.refresh(undefined, true);
    assert.equal(cache.snapshot, previous);
    assert.equal(await readFile(join(path, 'catalog-v1.json'), 'utf8'), saved);
  }
});

test('bounds declared and streamed response sizes and cancels rejected bodies', async (t) => {
  let cancelled = 0;
  let mode: 'header' | 'stream' = 'header';
  const block = new Uint8Array(1024 * 1024);
  const cache = new ModelMetadataCache({ directory: await directory(t), now: () => NOW, fetch: async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(block); }, cancel() { cancelled++; },
    });
    return new Response(body, { headers: { 'content-type': 'application/json',
      ...(mode === 'header' ? { 'content-length': String(MAX_BYTES + 1) } : {}) } });
  } });
  await cache.refresh();
  assert.equal(cancelled, 1);
  assert.equal(cache.snapshot, bundledMetadata);
  mode = 'stream';
  await cache.refresh(undefined, true);
  assert.equal(cancelled, 2);
  assert.equal(cache.snapshot, bundledMetadata);
});

test('times out a fetch implementation that ignores cancellation', { timeout: 1000 }, async (t) => {
  let signal: AbortSignal | null | undefined;
  const cache = new ModelMetadataCache({ directory: await directory(t), now: () => NOW, timeoutMs: 10,
    fetch: async (_url, options) => { signal = options?.signal; return new Promise<Response>(() => {}); } });
  await cache.refresh();
  assert.equal(signal?.aborted, true);
  assert.equal(cache.snapshot, bundledMetadata);
});

test('times out and cancels a stalled response body', { timeout: 1000 }, async (t) => {
  let cancelled = false;
  const cache = new ModelMetadataCache({ directory: await directory(t), now: () => NOW, timeoutMs: 10,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }),
      { headers: { 'content-type': 'application/json' } }) });
  await cache.refresh();
  assert.equal(cancelled, true);
  assert.equal(cache.snapshot, bundledMetadata);
});

test('caller cancellation skips pre-aborted requests and cleans up late responses', { timeout: 1000 }, async (t) => {
  let requests = 0;
  let release!: (value: Response) => void;
  const waiting = new Promise<Response>((resolve) => { release = resolve; });
  const cache = new ModelMetadataCache({ directory: await directory(t), now: () => NOW,
    fetch: async () => { requests++; return waiting; } });
  const preAborted = new AbortController();
  preAborted.abort();
  await cache.refresh(preAborted.signal);
  assert.equal(requests, 0);
  const controller = new AbortController();
  const pending = cache.refresh(controller.signal);
  controller.abort();
  await pending;
  let cancelled = false;
  release(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }),
    { headers: { 'content-type': 'application/json' } }));
  await nextTurn();
  assert.equal(cancelled, true);
  assert.equal(cache.snapshot, bundledMetadata);
});

test('a failed disk write still keeps valid refreshed metadata in memory', async (t) => {
  const path = join(await directory(t), 'a-file');
  await writeFile(path, 'not a directory');
  const cache = new ModelMetadataCache({ directory: path, now: () => NOW, fetch: async () => response() });
  await cache.refresh();
  assert.ok(cache.snapshot.providers.future_vendor?.['future-model']);
});
