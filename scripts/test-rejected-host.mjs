import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireSupportedPiVersion, UNSUPPORTED_PI_HOST } from '../src/host-compat.mjs';
import { readPiVersion, switchSource } from './install.mjs';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const hostName = '@earendil-works/pi-coding-agent';
const rejectedVersions = ['0.86.1', '0.87.1', '0.99.2'];
const digest = value => createHash('sha256').update(value).digest('hex');
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

function snapshot(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) {
      result.push({ path: relative(directory, path), directory: true });
      result.push(...snapshot(path).map(value => ({ ...value, path: join(entry.name, value.path) })));
    } else {
      assert.equal(entry.isFile(), true);
      const info = lstatSync(path, { bigint: true });
      result.push({ path: relative(directory, path), sha256: digest(readFileSync(path)),
        mode: String(info.mode), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) });
    }
  }
  return result;
}

async function worker(input) {
  const { version, fixture, stateRoot, output } = input;
  assert.ok(rejectedVersions.includes(version));
  const agentDir = join(stateRoot, 'agent'), cwd = join(stateRoot, 'project');
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(cwd, '.pi'), { recursive: true, mode: 0o700 });
  const previousSource = join(stateRoot, 'previous-provider');
  mkdirSync(previousSource, { mode: 0o700 });
  write(join(previousSource, 'package.json'), { name: '@tokennotincluded/pi-lmm-provider' });
  write(join(agentDir, 'settings.json'), { packages: [previousSource] });
  write(join(cwd, '.pi', 'settings.json'), { packages: [previousSource] });
  write(join(agentDir, 'auth.json'), { fixture: 'unchanged-local-sentinel' });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1'; process.env.PI_TELEMETRY = '0'; process.env.PI_SKIP_VERSION_CHECK = '1';
  const before = snapshot(stateRoot);
  const observationKey = 'lmm-test-rejected-host-observation';
  const observed = { invoked: false, version: null, apiReads: [], apiCalls: [] };
  globalThis[Symbol.for(observationKey)] = observed;
  try {
    const packageDirectory = realpathSync(join(fixture, 'node_modules', hostName));
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
    assert.equal(manifest.name, hostName); assert.equal(manifest.version, version);
    const entry = realpathSync(resolve(packageDirectory, manifest.exports['.'].import));
    assert.ok(entry.startsWith(packageDirectory + sep));
    const host = await import(pathToFileURL(entry).href);
    assert.equal(host.VERSION, version, 'the real imported host must be the selected old version');
    const piBin = realpathSync(join(fixture, 'node_modules', '.bin', 'pi'));
    assert.ok(piBin.startsWith(packageDirectory + sep));
    assert.equal(readPiVersion(piBin, cwd), version, 'the exact installer executable reports the selected old version');

    // The real host loader supplies the ExtensionAPI. This proxy only observes
    // access/calls; it never fabricates a provider, a successful result, or a host version.
    const wrapper = join(output, 'observed-extension.ts');
    const wrapperSource = `import extension from ${JSON.stringify(pathToFileURL(join(root, 'src/index.ts')).href)};
import { VERSION } from '@earendil-works/pi-coding-agent';
export default function (pi) {
  const state = globalThis[Symbol.for(${JSON.stringify(observationKey)})];
  state.invoked = true; state.version = VERSION;
  const observed = new Proxy(pi, { get(target, key, receiver) {
    state.apiReads.push(String(key));
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? (...args) => {
      state.apiCalls.push(String(key)); return Reflect.apply(value, target, args);
    } : value;
  } });
  return extension(observed);
}
`;
    writeFileSync(wrapper, wrapperSource, { flag: 'wx', mode: 0o600 });
    const loaded = await host.discoverAndLoadExtensions([wrapper], cwd, agentDir);
    assert.equal(observed.invoked, true, 'the real loader must call the extension factory');
    assert.equal(observed.version, version, 'the extension imports the executing host, not a local modern peer');
    assert.deepEqual(observed.apiReads, []);
    assert.deepEqual(observed.apiCalls, []);
    assert.deepEqual(loaded.extensions, []);
    assert.equal(loaded.errors.length, 1);
    assert.ok(loaded.errors[0].error.startsWith(`Failed to load extension: ${UNSUPPORTED_PI_HOST}:`),
      'an arbitrary import or host failure is not the expected compatibility refusal');
    assert.deepEqual(snapshot(stateRoot), before, 'runtime refusal must not modify settings or credentials');

    assert.throws(() => switchSource(root, false, { cwd, agentDir, piBin }),
      error => error?.code === UNSUPPORTED_PI_HOST && error.message.startsWith(`${UNSUPPORTED_PI_HOST}:`));
    assert.deepEqual(snapshot(stateRoot), before, 'installer refusal must not install/remove either source scope');
    const networkObservations = readFileSync(input.networkLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(networkObservations.filter(value => value.event !== 'guard-installed'), [],
      'network calls are rejected and recorded in the actual loader and both real CLI version probes');
    assert.equal(networkObservations.length, 3, 'the worker and both actual CLI probes must install the network guard');
    assert.equal(new Set(networkObservations.map(value => value.pid)).size, 3);
    assert.equal(networkObservations.filter(value => value.pid === process.pid).length, 1);
    for (const probe of networkObservations.filter(value => value.pid !== process.pid)) {
      assert.equal(realpathSync(probe.argv[0]), piBin);
      assert.deepEqual(probe.argv.slice(1), ['--version']);
    }
    const result = { outcome: 'EXPECTED_UNSUPPORTED_HOST_REJECTION', supportedCompatibility: false,
      selectedVersion: version, actualRuntimeVersion: host.VERSION, extensionRuntimeVersion: observed.version,
      hostEntrySha256: digest(readFileSync(entry)), hostManifestSha256: digest(readFileSync(join(packageDirectory, 'package.json'))),
      installerExecutable: piBin, installerExecutableSha256: digest(readFileSync(piBin)),
      exactErrorCode: UNSUPPORTED_PI_HOST, factoryInvoked: observed.invoked, apiReads: observed.apiReads,
      apiCalls: observed.apiCalls, registeredExtensions: loaded.extensions.length, networkAttempts: [], networkObservations,
      stateUnchanged: true, stateBefore: before, stateAfter: snapshot(stateRoot), installerRefusedBeforeMutation: true };
    write(join(output, 'refusal-result.json'), result);
    console.log(JSON.stringify({ outcome: result.outcome, selectedVersion: version, exactErrorCode: UNSUPPORTED_PI_HOST,
      zeroRegistration: true, zeroNetwork: true, stateUnchanged: true, supportedCompatibility: false }));
  } finally {
    delete globalThis[Symbol.for(observationKey)];
  }
}

function sourceBinding() {
  const invoke = args => {
    const value = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    if (value.error) throw value.error;
    assert.equal(value.status, 0, 'source binding requires the real source checkout');
    return value.stdout;
  };
  assert.equal(realpathSync(invoke(['rev-parse', '--show-toplevel']).trim()), root);
  const head = invoke(['rev-parse', 'HEAD']).trim();
  if (process.env.GITHUB_SHA) assert.equal(head, process.env.GITHUB_SHA);
  assert.equal(invoke(['status', '--porcelain=v1', '--untracked-files=all']).trim(), '');
  return { head, tree: invoke(['rev-parse', 'HEAD^{tree}']).trim(),
    files: invoke(['ls-files', '-z']).split('\0').filter(Boolean).sort().map(path => ({ path, sha256: digest(readFileSync(join(root, path))) })) };
}

function parent(version) {
  assert.equal(process.platform, 'linux', 'the original host matrix uses Linux');
  assert.ok(rejectedVersions.includes(version), 'only the three explicitly unsupported fixed hosts belong to this negative lane');
  const sourceManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(sourceManifest.peerDependencies[hostName], '>=1.0.4');
  assert.equal(sourceManifest.overrides[hostName].undici, '8.12.2');
  assert.throws(() => requireSupportedPiVersion(version), error => error?.code === UNSUPPORTED_PI_HOST);
  const output = join(process.env.RUNNER_TEMP || tmpdir(), `pi-rejected-host-${version}`);
  mkdirSync(output, { mode: 0o700 });
  let fixture, before;
  const receipt = { purpose: 'actual rejection of an unsupported official host; not compatibility acceptance',
    version, expectedCode: UNSUPPORTED_PI_HOST, status: 'FAIL', commands: [],
    node: { version: process.version, executable: process.execPath, sha256: digest(readFileSync(process.execPath)) } };
  function run(label, command, args, cwd, timeout, maxBuffer = 4 * 1024 * 1024, env = process.env) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer, env });
    writeFileSync(join(output, label + '.stdout'), result.stdout || '', { mode: 0o600 });
    writeFileSync(join(output, label + '.stderr'), result.stderr || '', { mode: 0o600 });
    receipt.commands.push({ label, command, args, cwd, status: result.status, signal: result.signal,
      errorCode: result.error?.code ?? null, stdoutSha256: digest(result.stdout || ''), stderrSha256: digest(result.stderr || '') });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${label} failed; this is not an expected host rejection`);
    return result.stdout;
  }
  try {
    before = sourceBinding();
    write(join(output, 'source-before.json'), before);
    fixture = mkdtempSync(join(dirname(root), '.pi-rejected-host-'));
    chmodSync(fixture, 0o700);
    receipt.npmVersion = run('npm-version', 'npm', ['--version'], root, 10_000).trim();
    const raw = JSON.parse(run('official-host-metadata', 'npm', ['view', `${hostName}@${version}`, '--json'], root, 60_000));
    const metadata = Array.isArray(raw) ? (assert.equal(raw.length, 1), raw[0]) : raw;
    assert.equal(metadata.name, hostName); assert.equal(metadata.version, version);
    assert.match(metadata.dist.integrity, /^sha512-/);
    // This is an intentionally unsupported official-host fixture. It does not
    // alter or claim to satisfy the accepted source's peer/override/cohort contract.
    write(join(fixture, 'package.json'), { name: 'lmm-pi-rejection-fixture', private: true, version: '0.0.0',
      type: 'module', dependencies: { [hostName]: version } });
    run('official-host-install', 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], fixture, 300_000);
    const listing = JSON.parse(run('official-host-tree', 'npm', ['ls', '--all', '--json'], fixture, 60_000, 16 * 1024 * 1024));
    assert.deepEqual(listing.problems ?? [], []); assert.ok(!listing.error);
    const lock = JSON.parse(readFileSync(join(fixture, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages[`node_modules/${hostName}`].version, version);
    assert.equal(lock.packages[`node_modules/${hostName}`].integrity, metadata.dist.integrity);
    write(join(output, 'official-host-lock.json'), lock);
    // Preloading also covers the real child CLI processes; a parent-only fetch
    // replacement would not prove that the installer version probe stayed offline.
    const networkGuard = join(output, 'network-guard.mjs'), networkLog = join(output, 'network-observations.jsonl');
    const guardSource = `import { appendFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { Socket as DatagramSocket } from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
let records = 0;
const record = value => {
  records += 1;
  if (records > 33) return;
  const event = records === 33 ? { event: 'record-limit-exceeded' } : value;
  appendFileSync(${JSON.stringify(networkLog)}, JSON.stringify({ pid: process.pid, ...event }) + '\\n', { mode: 0o600 });
};
const refuse = kind => function () { record({ event: 'network-attempt', kind }); throw Error('LMM_REJECTION_UNEXPECTED_NETWORK'); };
globalThis.fetch = refuse('fetch');
Socket.prototype.connect = refuse('socket-connect');
DatagramSocket.prototype.send = refuse('datagram-send');
for (const key of Object.keys(dns)) if (key === 'lookup' || key === 'lookupService' || key.startsWith('resolve') || key === 'reverse') {
  if (typeof dns[key] === 'function') dns[key] = refuse('dns-' + key);
}
for (const key of Object.keys(dns.promises)) if (key === 'lookup' || key === 'lookupService' || key.startsWith('resolve') || key === 'reverse') {
  if (typeof dns.promises[key] === 'function') dns.promises[key] = refuse('dns-promise-' + key);
}
syncBuiltinESMExports();
record({ event: 'guard-installed', argv: process.argv.slice(1) });
`;
    writeFileSync(networkGuard, guardSource, { flag: 'wx', mode: 0o600 });
    const input = { version, fixture, stateRoot: join(fixture, 'private-state'), output, networkLog };
    const inputFile = join(output, 'worker-input.json'); write(inputFile, input);
    const nodeOptions = `${process.env.NODE_OPTIONS || ''} --import=${JSON.stringify(pathToFileURL(networkGuard).href)}`.trim();
    run('actual-host-refusal', process.execPath, [fileURLToPath(import.meta.url), '--worker', inputFile], root, 30_000,
      4 * 1024 * 1024, { ...process.env, NODE_OPTIONS: nodeOptions });
    const result = JSON.parse(readFileSync(join(output, 'refusal-result.json'), 'utf8'));
    assert.equal(result.outcome, 'EXPECTED_UNSUPPORTED_HOST_REJECTION');
    assert.equal(result.selectedVersion, version); assert.equal(result.supportedCompatibility, false);
    receipt.status = 'EXPECTED_REJECTION_VERIFIED';
  } finally {
    try {
      assert.ok(before, 'a missing initial source binding cannot pass');
      const after = sourceBinding(); write(join(output, 'source-after.json'), after);
      assert.deepEqual(after, before, 'negative qualification must preserve every tracked source byte');
      receipt.sourceUnchanged = true;
    } catch (error) { receipt.status = 'FAIL'; receipt.sourceUnchanged = false; receipt.bindingError = error.code || error.name; }
    // Public dependency fixture and synthetic state are owned by this invocation.
    // Raw logs, source bindings and failure evidence remain outside that fixture.
    try { if (fixture) rmSync(fixture, { recursive: true, force: true }); receipt.fixtureRemoved = !fixture || !existsSync(fixture); }
    catch { receipt.fixtureRemoved = false; receipt.status = 'FAIL'; }
    write(join(output, 'receipt.json'), receipt);
  }
  assert.equal(receipt.status, 'EXPECTED_REJECTION_VERIFIED');
  assert.equal(receipt.fixtureRemoved, true);
  console.log(JSON.stringify({ outcome: receipt.status, version, supportedCompatibility: false, evidence: output }));
}

if (process.argv[2] === '--worker') await worker(JSON.parse(readFileSync(process.argv[3], 'utf8')));
else parent(process.argv[2]);
