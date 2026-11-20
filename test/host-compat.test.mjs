import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MINIMUM_PI_VERSION, requireSupportedPiVersion, UNSUPPORTED_PI_HOST } from '../src/host-compat.mjs';
import { readPiVersion, switchSource } from '../scripts/install.mjs';

const unsupported = (error) => error?.code === UNSUPPORTED_PI_HOST
  && error.message.startsWith(`${UNSUPPORTED_PI_HOST}:`);

test('stable supported host versions use numeric comparison without a version ceiling', () => {
  for (const version of ['1.0.4', '1.0.4+pack.1', '1.0.10', '1.5.2', '2.0.0']) {
    assert.doesNotThrow(() => requireSupportedPiVersion(version), version);
  }
});

test('old, prerelease, missing and malformed host versions fail with the exact compatibility error', () => {
  for (const version of ['0.86.1', '0.87.1', '0.99.2', '1.0.3', '1.0.4-rc.1', '2.0.0-alpha.1',
    '01.0.4', '1.0.04', '1.0', 'v1.0.4', '1.0.4\nextra', '1.0.4+', '9007199254740992.0.0',
    '', null, undefined, {}, []]) {
    assert.throws(() => requireSupportedPiVersion(version), unsupported);
  }
});

test('both declared peers and root lock metadata share the runtime stable minimum', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent']) {
    assert.equal(manifest.peerDependencies[name], `>=${MINIMUM_PI_VERSION}`);
    assert.equal(lock.packages[''].peerDependencies[name], manifest.peerDependencies[name]);
  }
  assert.equal(manifest.overrides['@earendil-works/pi-coding-agent'].undici, '8.12.2');
});

test('installer version probe uses the selected executable with bounded captured output', () => {
  let call;
  const version = readPiVersion('/private/bin/pi', '/private/work', 'linux', (command, args, options) => {
    call = { command, args, options };
    return { status: 0, stdout: '1.5.2\n', stderr: 'non-version diagnostic\n' };
  });
  assert.equal(version, '1.5.2');
  assert.equal(call.command, '/private/bin/pi');
  assert.deepEqual(call.args, ['--version']);
  assert.equal(call.options.cwd, '/private/work');
  assert.equal(call.options.shell, false);
  assert.equal(call.options.timeout, 5000);
  assert.equal(call.options.maxBuffer, 4096);
});

test('Windows version probe preserves argv without interpolating the executable into PowerShell', () => {
  const executable = 'C:\\Program Files\\Pi & tools\\pi.cmd';
  let call;
  assert.equal(readPiVersion(executable, 'C:\\work', 'win32', (command, args, options) => {
    call = { command, args, options };
    return { status: 0, stdout: '1.0.4\r\n' };
  }), '1.0.4');
  assert.equal(call.command, 'powershell.exe');
  assert.equal(call.options.env.LMM_PI_BIN, executable);
  assert.deepEqual(JSON.parse(call.options.env.LMM_PI_ARGS), ['--version']);
  assert.equal(Buffer.from(call.args.at(-1), 'base64').toString('utf16le').includes(executable), false);
  assert.equal(call.options.shell, false);
});

test('failed or interrupted version probes are not misclassified as a supported host', () => {
  for (const result of [{ status: 1, stdout: '1.5.2' }, { status: null, signal: 'SIGTERM', stdout: '1.5.2' },
    { status: 0, stdout: '1.5.2', error: new Error('timeout') }, { status: 0 }]) {
    assert.throws(() => readPiVersion('/private/pi', '/private/work', 'linux', () => result),
      (error) => error?.code === 'LMM_PI_HOST_UNVERIFIED');
  }
});

test('an unsupported selected executable leaves both source scopes and stored credentials byte-identical', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-lmm-host-refusal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agentDir = join(directory, 'agent'), cwd = join(directory, 'project');
  mkdirSync(agentDir); mkdirSync(join(cwd, '.pi'), { recursive: true });
  const files = [join(agentDir, 'settings.json'), join(cwd, '.pi', 'settings.json'), join(agentDir, 'auth.json')];
  for (const file of files) writeFileSync(file, JSON.stringify({ packages: ['npm:existing-provider'], fixture: 'unchanged' }));
  const before = files.map(file => readFileSync(file));
  const inspections = [], mutations = [];
  for (const version of ['0.86.1', '0.87.1', '0.99.2']) {
    assert.throws(() => switchSource('npm:@tokennotincluded/pi-lmm-provider', false, {
      cwd, agentDir, piBin: join(directory, 'selected-pi'),
      inspectVersion(executable, workingDirectory) { inspections.push([executable, workingDirectory]); return version; },
      run(args) { mutations.push(args); },
    }), unsupported);
    assert.deepEqual(files.map(file => readFileSync(file)), before);
  }
  assert.deepEqual(mutations, []);
  assert.deepEqual(inspections, Array.from({ length: 3 }, () => [join(directory, 'selected-pi'), cwd]));
});

test('the plain Node installer entry can load its shared compatibility helper without a TypeScript loader', () => {
  const executable = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [executable], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: lmm-pi-provider/);
});
