/* Copyright (C) 2026 LIghtJUNction. AGPL-3.0-or-later. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, initTheme } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { LmmIntegration } from '../src/provider.ts';
import { registerRemoteControl } from '../src/remote-control.ts';
import { parseRemoteCommand, validRemoteImages } from '../src/remote-wire.ts';
import { INITIAL_SCOPES } from '../src/protocol.ts';
import { remoteFixture, until } from './remote-fixture.mjs';
const image = { type: 'image', mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==' };
test('remote image validation rejects malformed, oversized and ambiguous attachments', () => {
  assert.ok(validRemoteImages([image]));
  const command = { version: 1, type: 'command', id: 'image-command-id', issued_at: Date.now(), action: 'prompt', content: '', images: [image] };
  assert.ok(parseRemoteCommand(command));
  for (const images of [[], [image, image], [{ ...image, data: 'invalid' }], [{ ...image, mimeType: 'image/svg+xml' }], [{ ...image, data: image.data.repeat(50) }]]) assert.equal(parseRemoteCommand({ ...command, images }), undefined);
  assert.equal(parseRemoteCommand({ ...command, content: 'x'.repeat(32000), images: [{ ...image, data: Buffer.from('\xff\xd8\xff' + 'x'.repeat(24000) + '\xff\xd9', 'latin1').toString('base64') }] }), undefined);
});
test('encrypted image prompt reaches actual Pi SDK and text-only models refuse it', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'pi-remote-images-'));
  const fixture = await remoteFixture();
  const integration = new LmmIntegration({ issuer: fixture.origin, allowLoopbackHttpForTests: true });
  let session;
  try {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('lmm', async () => ({ type: 'oauth', access: 'lmm_at_fixture', refresh: 'refresh_fixture', expires: Date.now() + 3600000, lmm_issuer: fixture.origin, lmm_resource: `${fixture.origin}/api/oauth2`, lmm_session: 'image-owner', scope: INITIAL_SCOPES.join(' ') }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const faux = fauxProvider({ provider: 'remote-image-fixture', models: [{ id: 'vision' }, { id: 'text-only', input: ['text'] }] });
    runtime.registerNativeProvider(faux.provider);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager: settings, noExtensions: true, disabledBuiltinExtensions: ['mcp'], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => { pi.registerProvider(integration.provider); registerRemoteControl(pi, integration, join(temp, 'remote.json')); }] });
    await loader.reload();
    const result = await createAgentSession({ cwd: temp, agentDir: temp, modelRuntime: runtime, model: faux.getModel(), resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(temp), noTools: true });
    assert.deepEqual(result.extensionsResult.errors, []);
    session = result.session;
    initTheme('dark', false);
    const notices = [], errors = [];
    await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), notify(message) { notices.push(message); }, confirm: async () => true }, mode: 'tui', onError: error => errors.push(error) });
    await session.prompt('/lmm-remote on');
    const pin = notices.find(n => n.includes('PIN:')).match(/PIN: (\S+)/)[1];
    const id = [...fixture.sessions.keys()][0];
    faux.setResponses([context => {
      const message = context.messages.findLast(m => m.role === 'user');
      assert.deepEqual(message.content.find(b => b.type === 'image'), image);
      return fauxAssistantMessage('Image received');
    }]);
    await fixture.command(id, pin, { action: 'prompt', content: '', images: [image] });
    await until(() => session.messages.some(m => m.role === 'assistant' && m.content.some(b => b.text === 'Image received')));
    assert.equal(faux.state.callCount, 1);
    await session.setModel(faux.getModel('text-only'));
    await fixture.command(id, pin, { action: 'prompt', content: 'Refuse image', images: [image] });
    await until(async () => (await fixture.events(id, pin)).some(e => e.type === 'ack' && !e.ok && e.content === 'The selected Pi model does not support images.'));
    assert.equal(faux.state.callCount, 1);
    assert.deepEqual(errors, []);
    assert.ok(fixture.requests.every(r => !r.body.includes(image.data) && !r.body.includes(pin)));
    await session.prompt('/lmm-remote off');
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose(); }
    integration.dispose(); await fixture.close(); await rm(temp, { recursive: true, force: true });
  }
});
