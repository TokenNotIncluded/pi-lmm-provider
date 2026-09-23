#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PACKAGE = '@tokennotincluded/pi-lmm-provider';
const REPOSITORY = 'tokennotincluded/pi-lmm-provider';

function readJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function packageSources(settingsPath) {
  const packages = readJson(settingsPath).packages ?? [];
  if (!Array.isArray(packages)) throw new Error(`Invalid packages list in ${settingsPath}`);
  return packages.map((item) => typeof item === 'string' ? item : item?.source).filter((item) => typeof item === 'string');
}

/** Recognize only this package; never remove an unrelated source by basename alone. */
export function isLmmPackageSource(source, baseDir) {
  if (source === `npm:${PACKAGE}` || source.startsWith(`npm:${PACKAGE}@`)) return true;
  if (source.startsWith('npm:')) return false;
  const git = source.replace(/^git\+?:(?:\/\/)?/i, '').replace(/^[a-z]+:\/\//i, '').replace(/^git@/i, '');
  if (/^github\.com[:/]tokennotincluded\/pi-lmm-provider(?:\.git)?(?:[@#].*)?$/i.test(git)) return true;
  if (/^github:tokennotincluded\/pi-lmm-provider(?:[@#].*)?$/i.test(git)) return true;
  if (source.startsWith('git:') || source.startsWith('https:') || source.startsWith('ssh:') || source.startsWith('github:')) return false;
  const path = isAbsolute(source) ? source : resolve(baseDir, source);
  try { return readJson(join(path, 'package.json')).name === PACKAGE; }
  catch { return false; }
}

function sourceKind(source) {
  if (source.startsWith('npm:')) return 'npm';
  if (/^(?:git:|git\+|https:|ssh:|github:)/i.test(source)) return 'git';
  return 'local';
}

export function planRemoval(source, local, userSettings, projectSettings, cwd) {
  const destination = local ? 'project' : 'user';
  const targetKind = sourceKind(source);
  const result = [];
  for (const [scope, path] of [['user', userSettings], ['project', projectSettings]]) {
    for (const installed of packageSources(path)) {
      if (!isLmmPackageSource(installed, dirname(path))) continue;
      if (scope === destination && sourceKind(installed) === targetKind &&
          (targetKind !== 'local' || resolve(dirname(path), installed) === resolve(cwd, source))) continue;
      result.push({ scope, source: sourceKind(installed) === 'local' ? resolve(dirname(path), installed) : installed });
    }
  }
  return result;
}

/** PowerShell passes arguments to pi.cmd as an array, never through command interpolation. */
export function runPi(piBin, args, cwd, platform = process.platform, spawn = spawnSync) {
  let result;
  if (platform === 'win32') {
    const script = "$ErrorActionPreference = 'Stop'; $piArgs = @(ConvertFrom-Json -InputObject $env:LMM_PI_ARGS); & $env:LMM_PI_BIN @piArgs; exit $LASTEXITCODE";
    result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      cwd, stdio: 'inherit', shell: false,
      env: { ...process.env, LMM_PI_BIN: piBin, LMM_PI_ARGS: JSON.stringify(args) },
    });
  } else {
    result = spawn(piBin, args, { cwd, stdio: 'inherit', shell: false });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pi ${args[0]} failed (${result.status ?? result.signal}).`);
}

export function switchSource(source, local = false, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  const userSettings = join(agentDir, 'settings.json');
  const projectSettings = join(cwd, '.pi', 'settings.json');
  if (!isLmmPackageSource(source, cwd)) throw new Error(`The source must contain ${PACKAGE}.`);
  const removals = planRemoval(source, local, userSettings, projectSettings, cwd);
  const defaultPi = process.platform === 'win32' ? 'pi.cmd' : 'pi';
  const piBin = options.piBin ?? process.env.LMM_PI_BIN ?? defaultPi;
  if (piBin !== defaultPi && !isAbsolute(piBin)) throw new Error('LMM_PI_BIN must be an absolute path to the installed Pi executable.');
  const run = options.run ?? ((args) => runPi(piBin, args, cwd));
  run(['install', ...(local ? ['--local'] : []), source]);
  for (const item of removals) run(['remove', ...(item.scope === 'project' ? ['--local'] : []), item.source]);
  const remaining = planRemoval(source, local, userSettings, projectSettings, cwd);
  if (remaining.length) throw new Error(`Other LMM sources remain configured: ${remaining.map((item) => `${item.scope}: ${item.source}`).join(', ')}`);
  return { source, removed: removals };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const args = process.argv.slice(2);
  const local = args.includes('--local');
  const source = args.find((arg) => arg !== '--local');
  if (args.length !== (local ? 2 : 1) || !source) {
    console.error('Usage: lmm-pi-provider <npm:... | git:... | /local/path> [--local]');
    process.exitCode = 2;
  } else {
    try {
      const result = switchSource(source, local);
      console.log(`Installed ${result.source}; removed ${result.removed.length} other LMM source(s).`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'LMM installation failed.');
      process.exitCode = 1;
    }
  }
}
