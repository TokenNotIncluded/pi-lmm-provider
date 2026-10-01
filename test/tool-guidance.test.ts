import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWriteTool, createEditTool, createBashTool, ExtensionRunner, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerToolGuidance, registerToolGuard } from '../src/tool-guidance.ts';

function prompt(provider: string, tools: string[]) {
  let handler: any;
  registerToolGuidance({
    on(name: string, callback: unknown) { assert.equal(name, 'before_agent_start'); handler = callback; },
    getActiveTools: () => tools,
  } as unknown as ExtensionAPI);
  return handler({ systemPrompt: 'original prompt' }, { model: { provider } })?.systemPrompt;
}

test('LMM instructions preserve the host prompt and use only active native tools', () => {
  const result = prompt('lmm', ['write', 'edit', 'bash']);
  assert.ok(result.startsWith('original prompt\n'));
  assert.match(result, /native write tool/);
  assert.match(result, /native edit tool/);
  assert.match(result, /Do not assume the Codex apply_patch command exists/);
  assert.match(result, /verify that the target file exists before opening/);
  assert.equal(prompt('openai', ['write']), undefined);
  const restricted = prompt('lmm', ['bash']);
  assert.doesNotMatch(restricted, /native write tool|native edit tool/);
  assert.doesNotMatch(prompt('lmm', ['apply_patch']), /no registered apply_patch/);
});

test('native Pi write/edit create and update an artifact; failure leaves no artifact to open', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'lmm-native-tools-'));
  try {
    const write = createWriteTool(cwd);
    const edit = createEditTool(cwd);
    await write.execute('create', { path: 'preview.html', content: '<html>before</html>' });
    await edit.execute('update', { path: 'preview.html', edits: [{ oldText: 'before', newText: 'after' }] });
    assert.equal(await readFile(join(cwd, 'preview.html'), 'utf8'), '<html>after</html>');
    await assert.rejects(edit.execute('missing', { path: 'missing.html', edits: [{ oldText: 'before', newText: 'after' }] }));
    await assert.rejects(readFile(join(cwd, 'missing.html')), { code: 'ENOENT' });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// Exercise Pi's actual tool_call dispatcher, then the native bash executor only
// if the plugin did not block. No model/network is involved in this fixture.
async function guardFixture(cwd: string, commandPrefix?: string, sourcePath = 'builtin:bash', executionPrefix = commandPrefix) {
  const handlers = new Map<string, any[]>();
  registerToolGuard({
    on(name: string, handler: any) { handlers.set(name, [handler]); },
    getActiveTools: () => ['bash', 'write', 'edit'],
    getAllTools: () => [{ name: 'bash', sourceInfo: { path: sourcePath } }],
    getSettings: () => ({ shellCommandPrefix: commandPrefix }),
  } as unknown as ExtensionAPI);
  const receiver = { extensions: [{ path: 'test-lmm', handlers }], createContext: () => ({ cwd, model: { provider: 'lmm' } }) };
  const native = createBashTool(cwd, { commandPrefix: executionPrefix });
  return async (command: string) => {
    const result = await ExtensionRunner.prototype.emitToolCall.call(receiver as any, {
      type: 'tool_call', toolName: 'bash', toolCallId: 'fixture', input: { command },
    });
    if (result?.block) return result;
    await native.execute('fixture', { command });
    return result;
  };
}

test('missing apply_patch blocks a real bash call; failed write cannot open a missing preview', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'lmm-tool-guard-'));
  try {
    // A shell function forces a deterministic missing-command probe even if
    // the developer machine happens to have an apply_patch executable.
    const guarded = await guardFixture(cwd, 'command() { return 1; }');
    const blocked = await guarded('apply_patch <<\'PATCH\'\ninvalid\nPATCH\ntouch should-not-run');
    assert.equal(blocked?.block, true);
    assert.match(blocked!.reason!, /native write\/edit/);
    await assert.rejects(readFile(join(cwd, 'should-not-run')), { code: 'ENOENT' });
    const failed = createWriteTool(cwd, { operations: {
      async mkdir() {}, async writeFile() { throw new Error('write failure fixture'); },
    } });
    await assert.rejects(failed.execute('failure', { path: 'preview.html', content: 'html' }));
    const preview = await (await guardFixture(cwd))('xdg-open preview.html');
    assert.equal(preview?.block, true);
    assert.match(preview!.reason!, /does not exist/);
    await createWriteTool(cwd).execute('recover', { path: 'preview.html', content: 'html' });
    // Existing preview passes the guard; use a shell function so no GUI launches.
    const successful = await guardFixture(cwd, undefined, 'builtin:bash', 'xdg-open() { touch preview-opened; }');
    await successful('xdg-open preview.html');
    assert.equal(await readFile(join(cwd, 'preview-opened'), 'utf8'), '');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('an available apply_patch command still executes; custom bash environments are untouched', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'lmm-tool-guard-'));
  try {
    const available = await guardFixture(cwd, 'apply_patch() { touch patch-ran; }');
    await available('apply_patch');
    assert.equal(await readFile(join(cwd, 'patch-ran'), 'utf8'), '');
    const custom = await guardFixture(cwd, 'apply_patch() { touch custom-ran; }', '/remote/bash.ts');
    await custom('apply_patch');
    assert.equal(await readFile(join(cwd, 'custom-ran'), 'utf8'), '');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
