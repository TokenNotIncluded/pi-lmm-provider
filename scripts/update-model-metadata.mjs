#!/usr/bin/env node
// Warm the public runtime cache; no curated provider/model list or OAuth credentials.
import { MODELS_DEV_URL, loadModelsDev } from '../src/models-dev-cache.ts';

const catalog = await loadModelsDev({ ttlMs: 0 });
console.log(JSON.stringify({ source: MODELS_DEV_URL, ...catalog.stats }));
if (!catalog.stats.models) {
  console.error('No public metadata cache is available. Account model discovery remains available.');
  process.exitCode = 1;
}
