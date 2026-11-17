import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MODELS_DEV_URL, ModelsDevCatalog, loadModelsDev, parseModelsDev, peekModelsDev } from '../src/models-dev-cache.ts';

const profile = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, name: id, canonical_model_id: 'lab/' + id,
  limit: { context: 128_000, input: 120_000, output: 8_000 },
  modalities: { input: ['text', 'image'], output: ['text'] },
  reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', null] }],
  tool_call: true, cost: { input: 2, output: 8 }, ...overrides,
});
const raw = () => ({ lab: { name: 'Lab', models: { 'claude-sonnet-4.5': profile('claude-sonnet-4.5') } } });
const response = (data: unknown, etag?: string) => new Response(JSON.stringify(data), {
  status: 200, headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) },
});
async function temporary(t: { after: (fn: () => Promise<unknown>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'lmm-metadata-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, cachePath: join(directory, 'models.json') };
}

test('new API models appear without a code list, matching formatting, provider prefixes, dates and typos', () => {
  const catalog = parseModelsDev(raw());
  assert.deepEqual(catalog.stats, { providers: 1, models: 1 });
  for (const id of ['claude-sonnet-4.5', 'LAB/Claude Sonnet 4-5', 'claude_4.5_sonnet',
    'claude-sonnet-4-5-20261117', 'claude-sonnet-4.5-latest', 'cluade-sonnet-4.5']) {
    assert.equal(catalog.resolve(id)?.id, 'claude-sonnet-4.5', id);
  }
  const expanded = raw();
  expanded.lab.models['claude-sonnet-4.5'] = profile('brandnew-42-8b') as ReturnType<typeof profile>;
  assert.equal(parseModelsDev(expanded).resolve('BrandNew_42_8B')?.id, 'brandnew-42-8b');
});

test('fuzzy lookup never crosses numeric generations, sizes or ambiguous identities', () => {
  const catalog = parseModelsDev({ lab: { models: {
    'model-4.1-8b': profile('model-4.1-8b'), 'model-4.1-80b': profile('model-4.1-80b'),
  } } });
  assert.equal(catalog.resolve('model-4.2-8b'), undefined);
  assert.equal(catalog.resolve('model-41-8b'), undefined);
  assert.equal(catalog.resolve('model-4.1-7b'), undefined);
  assert.equal(catalog.resolve('totally-new-4.1-8b'), undefined);
  assert.equal(new ModelsDevCatalog({ a: { models: { shared: profile('shared', { canonical_model_id: undefined }) } },
    b: { models: { shared: profile('shared', { canonical_model_id: undefined }) } } }).resolve('shared'), undefined);
});

test('canonical ownership selects the direct provider dynamically, without a vendor priority list', () => {
  const data = raw();
  const catalog = parseModelsDev({ ...data, reseller: { models: {
    'lab/claude-sonnet-4.5': profile('lab/claude-sonnet-4.5', { limit: { context: 32_000, output: 4_000 }, cost: { input: 10, output: 20 } }),
  } } });
  assert.equal(catalog.resolve('Claude-Sonnet-4.5')?.provider, 'lab');
  assert.equal(catalog.resolve('Claude-Sonnet-4.5', 'reseller')?.provider, 'reseller');
});

test('negative, infinite and absent rates stay unknown; multimodal outputs and reasoning metadata are retained', () => {
  const catalog = parseModelsDev({ lab: { models: {
    unknown: profile('unknown', { cost: undefined, interleaved: { field: 'reasoning_content' } }),
    negative: profile('negative', { cost: { input: -1, output: 4 } }),
    invalid: profile('invalid', { cost: { input: Infinity, output: 4 } }),
    audio: profile('audio', { modalities: { input: ['text'], output: ['text', 'audio'] }, cost: { input: 0, output: 0 } }),
  } } });
  for (const id of ['unknown', 'negative', 'invalid']) assert.equal(catalog.resolve(id)?.cost, undefined);
  assert.deepEqual(catalog.resolve('unknown')?.interleaved, { field: 'reasoning_content' });
  assert.deepEqual(catalog.resolve('unknown')?.reasoning_options?.[0]?.values, ['low', 'high', null]);
  assert.deepEqual(catalog.resolve('audio')?.modalities.output, ['text', 'audio']);
  assert.deepEqual(catalog.resolve('audio')?.cost, { input: 0, output: 0 });
});

test('cache cold load deduplicates requests, sends only public headers and writes a complete atomic file', async (t) => {
  const { cachePath, directory } = await temporary(t);
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), MODELS_DEV_URL);
    assert.equal(options?.credentials, 'omit');
    assert.deepEqual(Object.keys(options?.headers ?? {}).sort(), ['accept', 'user-agent']);
    return response(raw(), '"metadata-1"');
  };
  assert.equal(peekModelsDev(cachePath).stats.models, 0);
  const [first, second] = await Promise.all([
    loadModelsDev({ cachePath, fetch, now: () => 1_000 }),
    loadModelsDev({ cachePath, fetch, now: () => 1_000 }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(peekModelsDev(cachePath), first);
  assert.equal((await loadModelsDev({ cachePath, fetch, now: () => 1_001 })), first);
  assert.equal(calls, 1);
  const disk = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(disk.source, MODELS_DEV_URL);
  assert.equal(disk.etag, '"metadata-1"');
  assert.equal(disk.fetchedAt, 1_000);
  assert.deepEqual(await readdir(directory), ['models.json']);
});

test('fresh persistent cache avoids a network request after a process-style cold start', async (t) => {
  const { cachePath } = await temporary(t);
  await writeFile(cachePath, JSON.stringify({ version: 1, source: MODELS_DEV_URL, fetchedAt: 5_000, data: raw() }));
  const fetch: typeof globalThis.fetch = async () => { throw new Error('network must not be called'); };
  const result = await loadModelsDev({ cachePath, fetch, now: () => 5_001 });
  assert.equal(result.stats.models, 1);
});

test('expired metadata sends If-None-Match and 304 renews the persistent cache without replacing models', async (t) => {
  const { cachePath } = await temporary(t);
  await writeFile(cachePath, JSON.stringify({ version: 1, source: MODELS_DEV_URL, fetchedAt: 1, etag: '"etag-1"', data: raw() }));
  const fetch: typeof globalThis.fetch = async (_url, options) => {
    assert.equal((options?.headers as Record<string, string>)['if-none-match'], '"etag-1"');
    return new Response(null, { status: 304 });
  };
  const result = await loadModelsDev({ cachePath, ttlMs: 10, fetch, now: () => 100 });
  assert.equal(result.stats.models, 1);
  assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).fetchedAt, 100);
});

test('invalid refresh preserves stale file and adds a retry cooldown', async (t) => {
  const { cachePath } = await temporary(t);
  const original = JSON.stringify({ version: 1, source: MODELS_DEV_URL, fetchedAt: 1, data: raw() });
  await writeFile(cachePath, original);
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; return response({ error: 'maintenance' }); };
  assert.equal((await loadModelsDev({ cachePath, ttlMs: 1, fetch, now: () => 100 })).stats.models, 1);
  assert.equal(await readFile(cachePath, 'utf8'), original);
  assert.equal((await loadModelsDev({ cachePath, ttlMs: 1, fetch, now: () => 101 })).stats.models, 1);
  assert.equal(calls, 1);
});

test('corrupt local cache is replaced by a validated response', async (t) => {
  const { cachePath } = await temporary(t);
  await writeFile(cachePath, '{"partial":');
  const result = await loadModelsDev({ cachePath, fetch: async () => response(raw()), now: () => 200 });
  assert.equal(result.stats.models, 1);
  assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).fetchedAt, 200);
});

test('cold offline failure returns an empty reference and retries successfully after cooldown', async (t) => {
  const { cachePath } = await temporary(t);
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; throw new Error('offline'); };
  assert.equal((await loadModelsDev({ cachePath, fetch, now: () => 1_000 })).stats.models, 0);
  assert.equal((await loadModelsDev({ cachePath, fetch, now: () => 1_001 })).stats.models, 0);
  assert.equal(calls, 1);
  assert.equal((await loadModelsDev({ cachePath, fetch: async () => response(raw()), now: () => 61_001 })).stats.models, 1);
});

test('unwritable persistent cache does not discard successfully fetched metadata', async (t) => {
  const { cachePath } = await temporary(t);
  await writeFile(cachePath, 'this path is a file');
  const result = await loadModelsDev({ cachePath: join(cachePath, 'child.json'), fetch: async () => response(raw()), now: () => 1_000 });
  assert.equal(result.stats.models, 1);
});
