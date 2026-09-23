import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isLmmPackageSource, planRemoval, runPi, switchSource } from '../scripts/install.mjs';

const npm = 'npm:@tokennotincluded/pi-lmm-provider@0.1.0-alpha.2';
const git = 'git:github.com/TokenNotIncluded/pi-lmm-provider';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lmm-pi-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  const localPath = join(root, 'checkout');
  for (const dir of [agentDir, join(cwd, '.pi'), localPath]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(localPath, 'package.json'), JSON.stringify({ name: '@tokennotincluded/pi-lmm-provider' }));
  const userSettings = join(agentDir, 'settings.json');
  const projectSettings = join(cwd, '.pi', 'settings.json');
  const write = (path, packages) => writeFileSync(path, JSON.stringify({ packages }));
  const read = (path) => JSON.parse(readFileSync(path, 'utf8')).packages;
  write(userSettings, []); write(projectSettings, []);
  return { root, agentDir, cwd, localPath, userSettings, projectSettings, write, read };
}

test('recognizes only the official package across npm, Git and local paths', (t) => {
  const f = fixture(t);
  assert.equal(isLmmPackageSource(npm, f.cwd), true);
  assert.equal(isLmmPackageSource(git, f.cwd), true);
  assert.equal(isLmmPackageSource(f.localPath, f.cwd), true);
  assert.equal(isLmmPackageSource('npm:@tokennotincluded/pi-lmm-provider-fork', f.cwd), false);
  assert.equal(isLmmPackageSource('git:github.com/other/pi-lmm-provider', f.cwd), false);
});

test('switching source installs first, removes other sources in both scopes and keeps unrelated packages', (t) => {
  const f = fixture(t);
  f.write(f.userSettings, [git, 'npm:unrelated']);
  f.write(f.projectSettings, [f.localPath]);
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const path = args.includes('--local') ? f.projectSettings : f.userSettings;
    const source = args.at(-1);
    if (args[0] === 'install') f.write(path, [...f.read(path), source]);
    else f.write(path, f.read(path).filter((item) => item !== source));
  };
  const result = switchSource(npm, false, { cwd: f.cwd, agentDir: f.agentDir, run });
  assert.deepEqual(calls, [['install', npm], ['remove', git], ['remove', '--local', f.localPath]]);
  assert.deepEqual(f.read(f.userSettings), ['npm:unrelated', npm]);
  assert.deepEqual(f.read(f.projectSettings), []);
  assert.equal(result.removed.length, 2);
  assert.deepEqual(planRemoval(npm, false, f.userSettings, f.projectSettings, f.cwd), []);
});

test('a failed new installation leaves existing sources untouched', (t) => {
  const f = fixture(t);
  f.write(f.userSettings, [git]);
  assert.throws(() => switchSource(npm, false, { cwd: f.cwd, agentDir: f.agentDir, run() { throw new Error('install failed'); } }), /install failed/);
  assert.deepEqual(f.read(f.userSettings), [git]);
});

test('Windows pi.cmd arguments stay out of the PowerShell command text', () => {
  const source = 'C:\\A & B\\pi-lmm-provider';
  let call;
  runPi('C:\\Program Files\\Pi\\pi.cmd', ['install', source], 'C:\\work', 'win32', (command, args, options) => {
    call = { command, args, options };
    return { status: 0 };
  });
  assert.equal(call.command, 'powershell.exe');
  assert.equal(call.options.shell, false);
  assert.deepEqual(JSON.parse(call.options.env.LMM_PI_ARGS), ['install', source]);
  const script = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /ConvertFrom-Json/);
  assert.equal(script.includes(source), false);
});

test('local source switching never removes the target and cleans npm from the other scope', (t) => {
  const f = fixture(t);
  f.write(f.userSettings, [npm]);
  f.write(f.projectSettings, [f.localPath, git]);
  assert.deepEqual(planRemoval(f.localPath, true, f.userSettings, f.projectSettings, f.cwd), [
    { scope: 'user', source: npm }, { scope: 'project', source: git },
  ]);
});

test('real Pi CLI switches two local checkouts without leaving duplicate settings entries', (t) => {
  const f = fixture(t);
  const oldPath = join(f.root, 'old-checkout');
  mkdirSync(oldPath);
  writeFileSync(join(oldPath, 'package.json'), readFileSync(join(f.localPath, 'package.json')));
  const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
  const env = { ...process.env, PI_CODING_AGENT_DIR: f.agentDir };
  const run = (args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: f.cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };
  run(['install', oldPath]);
  switchSource(f.localPath, false, { cwd: f.cwd, agentDir: f.agentDir, run });
  assert.equal(f.read(f.userSettings).length, 1);
  assert.deepEqual(planRemoval(f.localPath, false, f.userSettings, f.projectSettings, f.cwd), []);
});
