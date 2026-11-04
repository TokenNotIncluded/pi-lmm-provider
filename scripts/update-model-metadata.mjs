#!/usr/bin/env node
// Public catalog only: never read OAuth credentials or send LMM account data.
import { writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODELS_DEV_URL, parseMetadataCatalog } from '../src/models-dev.ts';

const url = MODELS_DEV_URL;
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
const snapshot = parseMetadataCatalog(JSON.parse(bytes.toString('utf8')), new Date().toISOString(),
  createHash('sha256').update(bytes).digest('hex'));
const destination = outputArgument === -1 ? new URL('../src/models-dev.json', import.meta.url)
  : pathToFileURL(resolve(process.argv[outputArgument + 1]));
const temporary = new URL(`${destination.href}.tmp`);
await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n');
await rename(temporary, destination);
console.log(`Updated ${Object.values(snapshot.providers).reduce((n, models) => n + Object.keys(models).length, 0)} model records from ${url}`);
