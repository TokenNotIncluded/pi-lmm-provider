import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
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
const developmentPins = JSON.parse(readFileSync(inputs[0], 'utf8')).devDependencies ?? {};
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

// Read installed manifests without importing payload-only packages such as esbuild's
// platform binary. Only declared runtime edges from the selected cohort are evidence.
function declaredRuntimePackages(identities) {
  const boundary = realpathSync(join(root, 'node_modules')) + sep;
  const pending = [...identities.values()].map(identity => ({ packageJson: identity.packageJson, via: [] }));
  const seen = new Map();
  for (const item of pending) {
    const packageJson = realpathSync(item.packageJson);
    assert.ok(packageJson.startsWith(boundary), 'Selected dependency escaped this installation');
    if (seen.has(packageJson)) continue;
    assert.ok(seen.size < 4096, 'Unexpectedly large installed dependency closure');
    const bytes = readFileSync(packageJson);
    const manifest = JSON.parse(bytes);
    assert.equal(typeof manifest.name, 'string');
    assert.equal(typeof manifest.version, 'string');
    const record = { name: manifest.name, version: manifest.version, packageJson,
      manifestSha256: digest(bytes), via: item.via };
    seen.set(packageJson, record);
    const declared = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const [name, spec] of Object.entries(declared)) {
      assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i);
      const optional = Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
        (!Object.hasOwn(manifest.dependencies ?? {}, name) && manifest.peerDependenciesMeta?.[name]?.optional === true);
      let target;
      for (const directory of createRequire(packageJson).resolve.paths(name) ?? []) {
        const path = join(directory, name, 'package.json');
        try { target = realpathSync(path); break; }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      }
      assert.ok(target || optional, 'Missing declared dependency ' + manifest.name + ' -> ' + name);
      if (!target) continue; // An absent optional/platform package is not invented.
      assert.ok(target.startsWith(boundary), 'Declared dependency escaped this installation');
      const installed = JSON.parse(readFileSync(target, 'utf8'));
      const alias = typeof spec === 'string' && /^npm:((?:@[^/]+\/)?[^@]+)@/.exec(spec);
      assert.equal(installed.name, alias ? alias[1] : name, 'Installed dependency name differs from its declaration');
      assert.ok(pending.length < 16384, 'Unexpectedly large installed dependency graph');
      pending.push({ packageJson: target, via: [...item.via, {
        consumer: manifest.name, consumerPackageJson: packageJson, consumerManifestSha256: record.manifestSha256,
        dependency: name, declared: spec, packageJson: target,
      }] });
    }
  }
  return new Map([...seen.values()].map(record =>
    ['extraneous: ' + record.name + '@' + record.version + ' ' + dirname(record.packageJson), record]));
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
  const install = spawnSync(npm, ['install', '--no-save', '--package-lock=false', '--ignore-scripts', ...names.map(name => `${name}@${version}`)], {
    cwd: root, stdio: 'inherit', timeout: 300_000,
  });
  if (install.error) throw install.error;
  assert.equal(install.status, 0, 'Failed to install the selected official Pi dependency cohort');

  const listing = spawnSync(npm, ['ls', '--all', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  });
  console.log(JSON.stringify({ event: 'installed-npm-ls', status: listing.status, stdout: listing.stdout, stderr: listing.stderr }));
  if (listing.error) throw listing.error;
  assert.ok(listing.status === 0 || listing.status === 1, 'npm ls could not inspect the installed tree');
  const tree = JSON.parse(listing.stdout);
  const identities = new Map(names.map(name => [name, resolveFrom(name, root)]));
  console.log(JSON.stringify({ event: 'installed-pi-identities', packages: [...identities.values()] }));
  for (const identity of identities.values()) assert.equal(identity.version, version, `${identity.name} must match the selected host`);
  // --no-save intentionally keeps the root's dev pins. Only their corresponding
  // invalid/extraneous reports are allowed; dependency errors still fail here.
  const expectedProblems = new Set([...identities.values()].flatMap(identity =>
    (Object.hasOwn(developmentPins, identity.name) ? ['invalid', 'extraneous'] : ['extraneous'])
      .map(kind => `${kind}: ${identity.name}@${version} ${dirname(identity.packageJson)}`)));
  const unexpected = (tree.problems ?? []).filter(problem => !expectedProblems.has(problem));
  // Invalid/missing diagnostics are never excused by dependency reachability.
  for (const problem of unexpected) assert.ok(problem.startsWith('extraneous: '), 'Unexpected npm dependency problem: ' + problem);
  const declared = unexpected.length ? declaredRuntimePackages(identities) : new Map();
  for (const problem of unexpected) {
    const proof = declared.get(problem);
    assert.ok(proof, 'Unexpected npm dependency problem: ' + problem);
    console.log(JSON.stringify({ event: 'pi-proven-extraneous', problem, ...proof }));
  }
  if (listing.status === 1) {
    assert.ok(tree.problems?.length, 'npm ls failed without recognized dependency diagnostics');
    if (tree.error) assert.equal(tree.error.code, 'ELSPROBLEMS');
  }
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
