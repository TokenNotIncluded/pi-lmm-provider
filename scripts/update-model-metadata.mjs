#!/usr/bin/env node
// Public catalog only: never read OAuth credentials or send LMM account data.
import { writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { metadataProviders, parseModelMetadata, parseMetadataTransport } from '../src/models-dev.ts';

const url = 'https://models.dev/api.json';
const fromStdin = process.argv.includes('--stdin');
const outputArgument = process.argv.indexOf('--output');
if (outputArgument !== -1 && !process.argv[outputArgument + 1]) throw new Error('--output requires a path');
const response = fromStdin ? undefined : await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
if (response && !response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
// --stdin supports curl/proxy setups without adding a runtime dependency.
// Bound the download even if the server omits Content-Length.
const chunks = [];
let size = 0;
for await (const chunk of fromStdin ? process.stdin : response.body) {
  size += chunk.byteLength;
  if (size > 32 * 1024 * 1024) throw new Error('models.dev catalog exceeds 32 MiB');
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
const catalog = JSON.parse(bytes.toString('utf8'));
const providers = {};
const excluded = {};
const transports = {};
for (const provider of metadataProviders) {
  const source = catalog[provider]?.models;
  if (!source || typeof source !== 'object') throw new Error(`Missing models.dev provider: ${provider}`);
  const records = Object.create(null);
  const protocols = Object.create(null);
  const rejected = [];
  for (const id of Object.keys(source).sort()) {
    const model = source[id];
    if (!model || typeof model !== 'object' || Array.isArray(model) || model.id !== id) {
      throw new Error(`Invalid models.dev model ID: ${provider}/${id}`);
    }
    const metadata = parseModelMetadata(model);
    if (metadata) {
      records[id] = metadata;
      // A model override wins, including an unknown override: never silently use
      // the provider adapter when that exact model declares a different SDK.
      const npm = model.provider && Object.hasOwn(model.provider, 'npm') ? model.provider.npm : catalog[provider].npm;
      const transport = parseMetadataTransport(npm);
      if (transport) protocols[id] = transport;
    } else rejected.push(id);
  }
  if (!Object.keys(records).length) throw new Error(`No valid chat metadata: ${provider}`);
  providers[provider] = records;
  excluded[provider] = rejected;
  transports[provider] = protocols;
}
const snapshot = { source: url, fetchedAt: new Date().toISOString(), sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  license: 'MIT; see models-dev.LICENSE', providers, excluded, transports };
const destination = outputArgument === -1 ? new URL('../src/models-dev.json', import.meta.url)
  : pathToFileURL(resolve(process.argv[outputArgument + 1]));
const temporary = new URL(`${destination.href}.tmp`);
await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n');
await rename(temporary, destination);
console.log(`Updated ${Object.values(providers).reduce((n, models) => n + Object.keys(models).length, 0)} exact vendor model records from ${url}`);
