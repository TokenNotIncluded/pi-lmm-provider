import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWriteTool, createEditTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerToolGuidance } from '../src/tool-guidance.ts';

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
