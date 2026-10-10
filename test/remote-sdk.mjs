/* Actual Pi SDK and the published pi-ask-user package. No paid model or production account. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, cp, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, initTheme } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { LmmIntegration } from '../src/provider.ts';
import { registerRemoteControl } from '../src/remote-control.ts';
import { INITIAL_SCOPES } from '../src/protocol.ts';
import { remoteFixture, until } from './remote-fixture.mjs';
const require = createRequire(import.meta.url);
const hostRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const { KeybindingsManager } = await import(join(hostRoot, 'dist/core/keybindings.js'));
const { theme } = await import(join(hostRoot, 'dist/modes/interactive/theme/theme.js'));
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(join(root, '.remote-sdk-'));
const fixture = await remoteFixture();
const integration = new LmmIntegration({ issuer: fixture.origin, allowLoopbackHttpForTests: true });
let session;
const notifications = [];
const errors = [];
const browserRoot = process.env.REMOTE_BROWSER_ROOT;
if (browserRoot) fixture.setBrowserHandler(async (_req, res, url) => {
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!['index.html', 'browser.js', 'browser.css'].includes(name)) return false;
  res.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(await readFile(join(browserRoot, name))); return true;
});
try {
  const askRoot = process.env.PI_ASK_USER_PATH || dirname(require.resolve('pi-ask-user/package.json'));
  const vendor = join(temp, 'ask-user');
  await mkdir(vendor);
  for (const name of ['index.ts', 'single-select-layout.ts', 'package.json']) await cp(join(askRoot, name), join(vendor, name));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('lmm', async () => ({ type: 'oauth', access: 'lmm_at_fixture', refresh: 'refresh_fixture', expires: Date.now() + 3600_000,
    lmm_issuer: fixture.origin, lmm_resource: `${fixture.origin}/api/oauth2`, lmm_session: 'sdk-owner', scope: INITIAL_SCOPES.join(' ') }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const faux = fauxProvider({ provider: 'non-lmm-fixture', models: [{ id: 'independent-model' }, { id: 'another-model' }], tokensPerSecond: 100000 });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ defaultProvider: 'non-lmm-fixture', defaultModel: 'independent-model', compaction: { enabled: false }, retry: { enabled: false } });
  const remoteSettings = join(temp, 'lmm-remote.json');
  const loader = new DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager: settings,
    noExtensions: true, disabledBuiltinExtensions: ['mcp'], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(vendor, 'index.ts')],
    extensionFactories: [(pi) => { pi.registerProvider(integration.provider); registerRemoteControl(pi, integration, remoteSettings); }],
  });
  await loader.reload();
  const result = await createAgentSession({ cwd: temp, agentDir: temp, modelRuntime: runtime, model: faux.getModel(), resourceLoader: loader,
    settingsManager: settings, sessionManager: SessionManager.inMemory(temp), noTools: 'builtin' });
  assert.deepEqual(result.extensionsResult.errors, []);
  session = result.session;
  initTheme('dark', false);
  const keybindings = new KeybindingsManager();
  let view;
  let frames = [];
  const tui = { terminal: { columns: 100, rows: 50 }, requestRender() { if (view) frames = view.render(100); } };
  const ui = { ...session.extensionRunner.getUIContext(), theme,
    notify(message) { notifications.push(message); }, confirm: async () => true,
    custom(factory) { return new Promise((resolve, reject) => {
      const localDone = (value) => { view?.dispose?.(); view = undefined; resolve(value); };
      Promise.resolve(factory(tui, theme, keybindings, localDone)).then((component) => { view = component; tui.requestRender(); }, reject);
    }); },
  };
  await session.bindExtensions({ uiContext: ui, mode: 'tui', onError: (error) => errors.push(error) });
  await session.prompt('/lmm-remote on');
  const notification = notifications.find((value) => value.includes('PIN:'));
  assert.ok(notification, notifications.join('\n'));
  const pin = notification.match(/PIN: (\S+)/)[1];
  const id = [...fixture.sessions.keys()][0];
  assert.equal(session.model.provider, 'non-lmm-fixture');
  assert.ok(session.getActiveToolNames().includes('ask_user'));
  const nextQuestion = async () => (await fixture.events(id, pin)).findLast((event) => event.type === 'state')?.requests?.[0];
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Choose a deployment target', options: [{ title: 'Local test' }, { title: 'Staging test' }], allowFreeform: false, allowComment: false, displayMode: 'inline' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Remote answer received by the non-LMM model.'),
  ]);
  if (browserRoot) {
    await writeFile(join(browserRoot, 'fixture.json'), JSON.stringify({ origin: fixture.origin, pin, id }), { mode: 0o600 });
    console.log('BROWSER_READY ' + fixture.origin);
  } else await fixture.command(id, pin, { action: 'prompt', content: 'Run the remote ask_user check' });
  const question = await until(async () => { const value = await nextQuestion(); return value?.content?.includes('deployment') && value; }, browserRoot ? 180000 : 8000);
  assert.equal(question.kind, 'custom');
  console.log('PASS: real Pi SDK / non-LMM provider invoked published pi-ask-user and rendered its original component');
  if (!browserRoot) {
  await fixture.command(id, pin, { action: 'ui_input', request_id: question.request_id, key: 'down' });
  await until(async () => (await fixture.events(id, pin)).some((event) => event.type === 'ack' && event.ok));
  await fixture.command(id, pin, { action: 'ui_input', request_id: question.request_id, key: 'enter' });
  }
  await until(() => session.messages.some((message) => message.role === 'assistant' && message.content.some((block) => block.text?.includes('Remote answer received'))), browserRoot ? 180000 : 8000);
  const toolResult = session.messages.find((message) => message.role === 'toolResult' && message.toolName === 'ask_user');
  assert.ok(JSON.stringify(toolResult).includes('Staging test'), JSON.stringify(toolResult));
  assert.equal(toolResult.isError, false);
  assert.equal(faux.state.callCount, 2);
  console.log('PASS: encrypted keyboard answer returned the real ask_user result, then Pi continued the model turn');
  // Change model without switching away from this remote session.
  await session.setModel(faux.getModel('another-model'));
  assert.equal([...fixture.sessions.keys()][0], id);
  faux.setResponses([fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Stop while waiting', options: [{ title: 'Continue' }], allowFreeform: false, displayMode: 'inline' }), { stopReason: 'toolUse' })]);
  await fixture.command(id, pin, { action: 'prompt', content: 'Ask again, then stop' });
  await until(async () => (await nextQuestion())?.content?.includes('Stop while waiting'));
  if (!browserRoot) await fixture.command(id, pin, { action: 'abort' });
  await until(() => !session.isStreaming && !view, browserRoot ? 180000 : 8000);
  assert.equal([...fixture.sessions.keys()][0], id);
  console.log('PASS: model change kept the same remote session; remote Stop dismissed the active ask_user tool and stopped Pi');
  assert.equal(fixture.requests.filter((request) => request.path.includes('/models') || request.path.includes('/balance') || request.path.includes('/discovery')).length, 0);
  assert.ok(fixture.requests.every((request) => !request.body.includes(pin) && !request.body.includes('Staging test')));
  assert.deepEqual(errors, []);
  if (browserRoot) {
    console.log('BROWSER_ACTIONS_PASSED');
    await until(async () => { try { await readFile(join(browserRoot, 'finish')); return true; } catch { return false; } }, 180000);
  }
  await session.prompt('/lmm-remote off');
  assert.equal(fixture.sessions.size, 0);
  console.log('PASS: no LMM model/catalog/balance call; no plaintext or PIN on relay; disabling deletes the session');
} finally {
  if (session) { await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose(); }
  integration.dispose(); await fixture.close(); await rm(temp, { recursive: true, force: true });
}
