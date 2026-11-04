import { execFileSync } from 'node:child_process';

// Pi's sibling packages use caret ranges. Pin the selected release together so
// a locked newer sibling cannot silently change an older host's public API.
const selection = process.argv[2];
if (!selection || !/^(?:latest|\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(selection)) {
  throw new Error('Expected an exact Pi version or latest');
}
const view = (spec, field) => JSON.parse(execFileSync('npm', ['view', spec, field, '--json'],
  { encoding: 'utf8', timeout: 60000 }).trim() || '{}');
const version = view(`@earendil-works/pi-coding-agent@${selection}`, 'version');
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
  throw new Error('npm did not return an exact Pi release');
}
const packages = new Set(['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai']);
for (const name of packages) {
  const dependencies = view(`${name}@${version}`, 'dependencies');
  for (const dependency of Object.keys(dependencies)) {
    if (/^@earendil-works\/[a-z0-9-]+$/.test(dependency)) packages.add(dependency);
  }
}
console.log(`Testing coherent Pi ${version}: ${[...packages].sort().join(', ')}`);
execFileSync('npm', ['install', '--no-save', '--package-lock=false', '--ignore-scripts',
  ...[...packages].sort().map((name) => `${name}@${version}`)], { stdio: 'inherit' });
