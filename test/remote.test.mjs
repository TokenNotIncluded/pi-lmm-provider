/* Copyright (C) 2026 LIghtJUNction. AGPL-3.0-or-later. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LmmHttp } from '../src/http.ts';
import { LmmIntegration } from '../src/provider.ts';
import { RemoteClient } from '../src/remote-client.ts';
import { RemoteUiBridge } from '../src/remote-ui.ts';
import { deriveRemoteKey, encryptRemote, decryptRemote, remoteId, remoteAad, parseRemoteCommand } from '../src/remote-wire.ts';
import { remoteFixture, until } from './remote-fixture.mjs';

const command = (input) => ({ type: 'command', version: 1, id: remoteId(), issued_at: Date.now(), ...input });

test('remote crypto binds the sender and session; rejects wrong PIN and stale/unsafe commands', async () => {
  const id = remoteId();
  const key = await deriveRemoteKey('fixture-only', id);
  const payload = command({ action: 'prompt', content: 'test' });
  const encrypted = await encryptRemote(key, payload, remoteAad(id, 'message', 'controller'));
  assert.deepEqual(await decryptRemote(key, encrypted, remoteAad(id, 'message', 'controller')), payload);
  await assert.rejects(decryptRemote(key, encrypted, remoteAad(id, 'message', 'plugin')));
  await assert.rejects(decryptRemote(await deriveRemoteKey('wrong', id), encrypted, remoteAad(id, 'message', 'controller')));
  assert.equal(parseRemoteCommand({ ...payload, issued_at: Date.now() - 121_000 }), undefined);
  assert.equal(parseRemoteCommand(command({ action: 'ui_input', request_id: remoteId(), text: '\x1b[201~rm -rf /' })), undefined);
  assert.equal(parseRemoteCommand(command({ action: 'ui_input', request_id: remoteId(), key: 'ctrl+c' })), undefined);
  assert.ok(parseRemoteCommand(command({ action: 'ui_response', request_id: remoteId(), value: 1 })));
});

test('remote auth uses Pi credentials without model discovery, and never widens old consent', async () => {
  let requests = 0;
  const integration = new LmmIntegration({ fetch: async () => { requests++; throw new Error('catalog unavailable'); } });
  const credential = { type: 'oauth', access: 'lmm_at_fixture', refresh: 'refresh_fixture', expires: Date.now() + 3600_000,
    lmm_issuer: 'https://api.lmm.best', lmm_resource: 'https://api.lmm.best/api/oauth2', lmm_session: 'owner-one', scope: 'catalog:read balance:read usage:read models:invoke remote:control' };
  try {
    const result = await integration.resolveRemoteAuth(() => integration.provider.auth.oauth.toAuth(credential));
    assert.equal(result.session, 'owner-one');
    assert.equal(result.value.headers.authorization, 'Bearer lmm_at_fixture');
    assert.equal(requests, 0);
    await assert.rejects(integration.resolveRemoteAuth(() => integration.provider.auth.oauth.toAuth({ ...credential, scope: 'catalog:read models:invoke' })));
    assert.equal(requests, 0);
    await integration.provider.auth.oauth.toAuth(credential).catch(() => {});
    assert.ok(requests > 0, 'ordinary model auth retains its normal discovery path');
  } finally { integration.dispose(); }
});

test('real HTTP transport delivers stop while a question is pending, ignores replay, and recovers a restarted relay', async () => {
  const fixture = await remoteFixture();
  const received = [];
  const client = new RemoteClient({ http: new LmmHttp({ issuer: fixture.origin, allowLoopbackHttpForTests: true }),
    getAccessToken: async () => 'lmm_at_fixture', metadata: () => ({ runtime: 'non-lmm model fixture' }),
    onCommand: (value) => received.push(value), pollMs: 20, heartbeatMs: 80 });
  try {
    await client.start();
    client.publish({ type: 'state', id: 'remote-state', requests: [{ request_id: remoteId(), kind: 'input', question: 'still waiting' }] });
    const first = await fixture.command(client.sessionId, client.pin, { action: 'prompt', content: 'run on another provider' });
    await until(() => received.length === 1);
    await fixture.command(client.sessionId, client.pin, first);
    await fixture.post(client.sessionId, { sender: 'controller', nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA' });
    await fixture.command(client.sessionId, client.pin, { action: 'abort' });
    await until(() => received.length === 2);
    assert.deepEqual(received.map((value) => value.action), ['prompt', 'abort']);
    const oldGeneration = fixture.sessions.get(client.sessionId).generation;
    fixture.restart();
    await until(() => fixture.sessions.has(client.sessionId), 5_000);
    assert.notEqual(fixture.sessions.get(client.sessionId).generation, oldGeneration);
    await fixture.command(client.sessionId, client.pin, { action: 'prompt', content: 'after restart' });
    await until(() => received.length === 3);
    assert.equal(received[2].content, 'after restart');
    assert.ok(fixture.requests.every((request) => !request.body.includes(client.pin) && !request.body.includes('run on another provider')));
    fixture.setAuthorized(false);
    await until(() => !client.active);
  } finally { await client.stop(); await fixture.close(); }
});

test('standard dialogs preserve local results, validate selections, cancel cleanly and reject old replies', async () => {
  let active = true;
  let localResolve;
  let localAborted = 0;
  const local = (_title, _value, options) => new Promise((resolve) => {
    localResolve = resolve;
    options?.signal?.addEventListener('abort', () => { localAborted++; resolve(undefined); }, { once: true });
  });
  const ui = { select: local, confirm: local, input: local, editor: local, custom: local };
  const originalSelect = ui.select;
  const bridge = new RemoteUiBridge(() => active, () => {});
  bridge.install(ui);
  const result = ui.select('Choose', ['A', 'B']);
  const id = bridge.snapshot()[0].request_id;
  assert.throws(() => bridge.respond(command({ action: 'ui_response', request_id: id, value: 'not-an-option' })));
  bridge.respond(command({ action: 'ui_response', request_id: id, value: 1 }));
  assert.equal(await result, 'B');
  assert.equal(localAborted, 1);
  assert.throws(() => bridge.respond(command({ action: 'ui_response', request_id: id, value: 0 })));
  const localResult = ui.input('Local first');
  localResolve('from local keyboard');
  assert.equal(await localResult, 'from local keyboard');
  assert.deepEqual(bridge.snapshot(), []);
  const pending = ui.confirm('Confirm', 'continue?');
  bridge.cancelAll();
  assert.equal(await pending, false);
  active = false; bridge.dispose();
  assert.equal(ui.select, originalSelect);
});

test('custom terminal view returns the real component result and synchronous close prevents late input', async () => {
  let view;
  const ui = { select() {}, confirm() {}, input() {}, editor() {}, custom: (factory) => new Promise((resolve, reject) => {
    Promise.resolve(factory({ requestRender() {} }, {}, {}, resolve)).then((component) => { view = component; component.render(80); }, reject);
  }) };
  const bridge = new RemoteUiBridge(() => true, () => {});
  bridge.install(ui);
  let selected = 0;
  const result = ui.custom((_tui, _theme, _keys, done) => ({ render: () => ['\x1b[31mChoose A or B\x1b[0m'], invalidate() {}, handleInput(data) {
    if (data === '\x1b[B') selected++;
    if (data === '\r') done({ answer: selected ? 'B' : 'A' });
  } }));
  await until(() => view);
  const id = bridge.snapshot()[0].request_id;
  assert.equal(bridge.snapshot()[0].content, 'Choose A or B');
  bridge.respond(command({ action: 'ui_input', request_id: id, key: 'down' }));
  bridge.respond(command({ action: 'ui_input', request_id: id, key: 'enter' }));
  assert.throws(() => bridge.respond(command({ action: 'ui_input', request_id: id, key: 'enter' })));
  assert.deepEqual(await result, { answer: 'B' });
  bridge.dispose();
});

test('disabling remote control preserves completion of an already open local custom dialog', async () => {
  let done;
  const ui = { custom: async (factory) => new Promise((resolve) => { void factory({ requestRender() {} }, {}, {}, resolve); }), select() {}, confirm() {}, input() {}, editor() {} };
  const bridge = new RemoteUiBridge(() => true, () => {});
  bridge.install(ui);
  const result = ui.custom((_tui, _theme, _keys, finish) => { done = finish; return { render: () => ['local'], handleInput() {} }; });
  bridge.dispose();
  done('local still works');
  assert.equal(await result, 'local still works');
});
