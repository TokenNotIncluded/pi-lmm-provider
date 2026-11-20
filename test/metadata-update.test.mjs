import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('metadata updater warms the runtime cache with arbitrary providers instead of a curated snapshot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-lmm-metadata-'));
  try {
    const cache = join(directory, 'cache.json');
    const mock = join(directory, 'public-api.mjs');
    const data = { 'new-vendor': { models: { 'new-model-42': {
      id: 'new-model-42', reasoning: false, tool_call: false, limit: { context: 4096, output: 1024 },
      modalities: { input: ['text'], output: ['text'] },
    } } } };
    writeFileSync(mock, 'globalThis.fetch = async () => Response.json(' + JSON.stringify(data) + ');\n');
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', mock, 'scripts/update-model-metadata.mjs'],
      { cwd: new URL('..', import.meta.url), env: { ...process.env, LMM_MODELS_DEV_CACHE: cache }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(readFileSync(cache, 'utf8'));
    assert.equal(envelope.source, 'https://models.dev/api.json?type=all');
    assert.deepEqual(envelope.data, data);
    assert.equal(JSON.parse(result.stdout).models, 1);
    assert.ok(envelope.fetchedAt > 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
