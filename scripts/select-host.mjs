import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Test-only selection; leave the committed package manifest and lockfile intact.
const selector = process.argv[2];
assert.ok(selector && /^(?:latest|\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(selector), 'Specify an official Pi version or latest');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const root = fileURLToPath(new URL('../', import.meta.url));
const host = '@earendil-works/pi-coding-agent';
const internal = name => name === '@earendil-works/chord' || name.startsWith('@earendil-works/pi-');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = ['package.json', 'package-lock.json'].map(name => new URL(`../${name}`, import.meta.url));
const before = inputs.map(path => digest(readFileSync(path)));
const sourceManifest = JSON.parse(readFileSync(inputs[0], 'utf8'));
function view(spec) {
  const metadata = JSON.parse(execFileSync(npm, ['view', spec, '--json'], {
    cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  }));
  if (!Array.isArray(metadata)) return metadata;
  assert.equal(metadata.length, 1, 'npm view must return exactly one selected package');
  return metadata[0];
}
function dependencies(manifest) {
  return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }).filter(internal).sort();
}

// Run ESM resolution from the real consumer directory, not from a guessed hoist.
const resolveCode = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const name = process.argv[1];
const entry = fileURLToPath(import.meta.resolve(name));
let dir = dirname(entry);
for (;;) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (manifest?.name === name) {
    console.log(JSON.stringify({ name, version: manifest.version, entry: realpathSync(entry),
      packageJson: realpathSync(join(dir, 'package.json')),
      entrySha256: createHash('sha256').update(readFileSync(entry)).digest('hex') }));
    break;
  }
  const parent = dirname(dir);
  assert.notEqual(parent, dir, 'Resolved package manifest was not found');
  dir = parent;
}
`;
function resolveFrom(name, cwd) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', resolveCode, name], {
    cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  }));
}

function fixtureManifest(names, version) {
  const manifest = structuredClone(sourceManifest);
  const selected = new Set(names);
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (!internal(name)) continue;
      assert.ok(selected.has(name), 'A direct Pi dependency is outside the selected host cohort');
      manifest[field][name] = version;
    }
  }
  manifest.devDependencies ??= {};
  for (const name of names) {
    if (!Object.hasOwn(manifest.dependencies ?? {}, name) && !Object.hasOwn(manifest.optionalDependencies ?? {}, name)) {
      manifest.devDependencies[name] = version;
    }
  }
  return manifest;
}

try {
  const selected = view(`${host}@${selector}`);
  assert.equal(selected.name, host);
  const version = selected.version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  if (selector !== 'latest') assert.equal(version, selector);
  const manifests = new Map([[host, selected]]);
  // Resolve latest once. The official installer also pins every internal package
  // in the selected host's dependency closure to that host's exact release.
  for (const manifest of manifests.values()) {
    for (const name of dependencies(manifest)) {
      if (manifests.has(name)) continue;
      assert.ok(manifests.size < 32, 'Unexpectedly large Pi internal dependency closure');
      const dependency = view(`${name}@${version}`);
      assert.equal(dependency.name, name);
      assert.equal(dependency.version, version);
      manifests.set(name, dependency);
    }
  }
  const names = [...manifests.keys()].sort();
  console.log(JSON.stringify({ event: 'official-pi-cohort', selector, version, packages: names.map(name => ({
    name, version, dependencies: dependencies(manifests.get(name)),
    integrity: manifests.get(name).dist?.integrity ?? null,
    gitHead: manifests.get(name).gitHead ?? null,
  })) }));
  // Solve a consistent temporary manifest, seeded by the original lock. Installing
  // an older cohort over --no-save dev pins can retain a second physical instance.
  const fixture = mkdtempSync(join(dirname(root), '.pi-host-matrix-'));
  chmodSync(fixture, 0o700);
  copyFileSync(inputs[0], join(fixture, 'source-package.json'));
  copyFileSync(inputs[1], join(fixture, 'source-package-lock.json'));
  copyFileSync(inputs[1], join(fixture, 'package-lock.json'));
  assert.deepEqual(['source-package.json', 'source-package-lock.json'].map(name =>
    digest(readFileSync(join(fixture, name)))), before, 'The fixture must use the exact source inputs');
  const manifest = fixtureManifest(names, version);
  const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(join(fixture, 'package.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
  const installArgs = ['install', '--ignore-scripts', '--prefer-dedupe'];
  console.log(JSON.stringify({ event: 'pi-install-fixture', fixture, sourceInputsSha256: before,
    manifestSha256: digest(manifestBytes), command: [npm, ...installArgs],
    npmVersion: execFileSync(npm, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim() }));
  const install = spawnSync(npm, installArgs, {
    cwd: fixture, stdio: 'inherit', timeout: 300_000,
  });
  if (install.error) throw install.error;
  assert.equal(install.status, 0, 'Failed to install the selected official Pi dependency cohort');

  const listing = spawnSync(npm, ['ls', '--all', '--json'], {
    cwd: fixture, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  });
  console.log(JSON.stringify({ event: 'installed-npm-ls', cwd: fixture, status: listing.status, stdout: listing.stdout, stderr: listing.stderr }));
  if (listing.error) throw listing.error;
  assert.equal(listing.status, 0, 'The selected fixture must have no npm dependency errors');
  const tree = JSON.parse(listing.stdout);
  assert.deepEqual(tree.problems ?? [], [], 'The selected fixture must have no npm dependency problems');
  assert.ok(!tree.error, 'npm ls reported an inspection error');
  assert.equal(readFileSync(join(fixture, 'package.json'), 'utf8'), manifestBytes, 'npm must preserve the selected fixture manifest');
  console.log(JSON.stringify({ event: 'pi-installed-fixture-lock',
    path: join(fixture, 'package-lock.json'), sha256: digest(readFileSync(join(fixture, 'package-lock.json'))) }));

  // Keep the original npm-ci tree for failure evidence. The new tree is moved on
  // the same filesystem so all original tests resolve from their real source root.
  const modules = join(root, 'node_modules');
  const installed = join(fixture, 'node_modules');
  assert.ok(lstatSync(modules).isDirectory(), 'Expected the original local npm-ci directory');
  assert.ok(lstatSync(installed).isDirectory(), 'Expected a local selected dependency directory');
  const baseline = join(fixture, 'baseline-node_modules');
  renameSync(modules, baseline);
  try { renameSync(installed, modules); }
  catch (error) { renameSync(baseline, modules); throw error; }
  console.log(JSON.stringify({ event: 'pi-installed-tree-handoff', modules, baseline }));

  const identities = new Map(names.map(name => [name, resolveFrom(name, root)]));
  console.log(JSON.stringify({ event: 'installed-pi-identities', packages: [...identities.values()] }));
  for (const identity of identities.values()) assert.equal(identity.version, version, `${identity.name} must match the selected host`);
  const undici = resolveFrom('undici', dirname(identities.get(host).packageJson));
  console.log(JSON.stringify({ event: 'pi-host-override-resolution', ...undici }));
  assert.equal(undici.version, sourceManifest.overrides[host].undici, 'The original host-scoped undici override must remain effective');
  for (const [name, manifest] of manifests) {
    for (const dependency of dependencies(manifest)) {
      const actual = resolveFrom(dependency, dirname(identities.get(name).packageJson));
      console.log(JSON.stringify({ event: 'pi-consumer-resolution', consumer: name, ...actual }));
      assert.equal(actual.version, version, `${name} resolved a different ${dependency} version`);
      assert.equal(actual.packageJson, identities.get(dependency).packageJson, `${name} resolved a second ${dependency} copy`);
    }
  }
  const hostExports = await import(host);
  console.log(JSON.stringify({ event: 'pi-host-import', entry: import.meta.resolve(host), exports: Object.keys(hostExports).sort() }));
  if (manifests.has('@earendil-works/pi-codemode')) {
    const spec = '@earendil-works/pi-codemode/declarations';
    const declarations = await import(spec);
    console.log(JSON.stringify({ event: 'pi-codemode-declarations', entry: import.meta.resolve(spec), exports: Object.keys(declarations).sort() }));
    if (version === '1.0.4') assert.equal(typeof declarations.MCP_TYPESCRIPT_PREAMBLE, 'string');
  }
} finally {
  assert.deepEqual(inputs.map(path => digest(readFileSync(path))), before, 'Host selection must not rewrite the manifest or lockfile');
}
