import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { metadataProviders } from '../src/models-dev.ts';

test('offline metadata refresh records source digest, excludes non-chat and preserves old output on failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-lmm-metadata-'));
  try {
    const output = join(directory, 'snapshot.json');
    const fixture = Object.fromEntries(metadataProviders.map((provider) => [provider, { npm: '@ai-sdk/openai-compatible', models: {
      verified: { id: 'verified', tool_call: true, reasoning: true,
        limit: { context: 1000, input: 800, output: 200 }, modalities: { input: ['text'], output: ['text'] },
        cost: { input: 999, output: 999 } },
      media: { id: 'media', type: 'image', tool_call: true, reasoning: false,
        limit: { context: 1000, output: 200 }, modalities: { input: ['text'], output: ['text', 'image'] } },
    } }]));
    const input = JSON.stringify(fixture);
    const refresh = (value) => spawnSync(process.execPath,
      ['--experimental-strip-types', 'scripts/update-model-metadata.mjs', '--stdin', '--output', output],
      { cwd: new URL('..', import.meta.url), input: value, encoding: 'utf8', timeout: 10000 });
    const result = refresh(input);
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(snapshot.source, 'https://models.dev/api.json');
    assert.equal(snapshot.sourceSha256, createHash('sha256').update(input).digest('hex'));
    assert.ok(Number.isFinite(Date.parse(snapshot.fetchedAt)));
    assert.deepEqual(snapshot.providers.openai.verified, { contextWindow: 800, maxTokens: 200, reasoning: true, input: ['text'] });
    assert.deepEqual(snapshot.excluded.openai, ['media']);
    assert.deepEqual(snapshot.transports.openai, { verified: 'openai-completions' });
    fixture.openai.models.verified.provider = { npm: '@unreviewed/adapter' };
    assert.equal(refresh(JSON.stringify(fixture)).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).transports.openai, {});
    fixture.openai.models.verified.provider = { npm: '@ai-sdk/anthropic' };
    assert.equal(refresh(JSON.stringify(fixture)).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).transports.openai, { verified: 'anthropic-messages' });
    assert.ok(!JSON.stringify(snapshot).includes('999'), 'public prices are not imported into account metadata');
    writeFileSync(output, 'preserve-me');
    assert.notEqual(refresh('{}').status, 0);
    assert.equal(readFileSync(output, 'utf8'), 'preserve-me');
    fixture.openai.models.verified.id = 'another-id';
    assert.notEqual(refresh(JSON.stringify(fixture)).status, 0);
    assert.equal(readFileSync(output, 'utf8'), 'preserve-me');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
