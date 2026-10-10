import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LmmIntegration } from './provider.ts';
import { LmmError } from './protocol.ts';
import { bearerFromHeaders } from './stream.ts';
import { RemoteClient } from './remote-client.ts';
import { RemoteUiBridge } from './remote-ui.ts';
import { remoteId, remoteRecord, type RemoteCommand } from './remote-wire.ts';

function boundedText(value: unknown, max = 12_000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  // A character limit of this size also bounds UTF-8 below the encrypted envelope limit.
  return text.length > max ? `${text.slice(0, max)}\n[See the local terminal for the remaining output.]` : text;
}

/** Owns the remote lifecycle. It never reads or changes the selected model provider. */
export function registerRemoteControl(pi: ExtensionAPI, integration: LmmIntegration, settingsPath: string): void {
  const http = integration.http;
  let context: ExtensionContext | undefined;
  let client: RemoteClient | undefined;
  let enabling: Promise<void> | undefined;
  let generation = 0;
  let enabled = false;
  let busy = false;
  let startedAt = Date.now();
  let messageId = remoteId();
  let lastStreamAt = 0;
  const bridge = new RemoteUiBridge(() => !!client?.active, publishState);

  function publishState() {
    client?.publish({ type: 'state', id: 'remote-state', busy, provider: context?.model?.provider,
      model: context?.model?.id, requests: bridge.snapshot() });
  }
  function notify(message: string, kind: 'info' | 'warning' | 'error' = 'info') {
    // Notifications stay in the local UI; never put a PIN in a session/model message.
    if (context?.hasUI) context.ui.notify(message, kind);
  }
  function acknowledge(command: RemoteCommand, error?: string) {
    client?.publish({ type: 'ack', id: `ack-${command.id}`, command_id: command.id,
      ok: !error, ...(error ? { content: error } : {}) });
  }
  function dispatch(command: RemoteCommand): void {
    if (!client?.active || !context) return;
    try {
      if (command.action === 'abort') { bridge.cancelAll(); context.abort(); }
      else if (command.action === 'prompt') {
        if (bridge.snapshot().length) throw new Error('Answer or cancel the current question before sending a new task.');
        // Do not expand /commands, skills or templates received over the network.
        // Calling this queues a turn. Never await that turn in the receive loop.
        pi.sendUserMessage(command.content!, { deliverAs: command.delivery ?? 'followUp', expandPromptTemplates: false });
      } else bridge.respond(command);
      acknowledge(command);
    } catch (error) {
      const message = error instanceof Error && command.action.startsWith('ui_') ? error.message
        : command.action === 'prompt' && bridge.snapshot().length ? 'Answer or cancel the current question first.' : 'Pi could not apply this command. Check the local terminal.';
      acknowledge(command, message);
    }
  }
  async function stop() {
    generation++;
    const previous = client;
    client = undefined;
    bridge.dispose();
    context?.ui.setStatus('lmm-remote', undefined);
    await previous?.stop();
  }
  async function connect(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const current = ++generation;
    context = ctx;
    startedAt = Date.now();
    let ownerSession: string | undefined;
    const remote = new RemoteClient({
      http,
      getAccessToken: async () => {
        const resolved = await integration.resolveRemoteAuth(() => ctx.modelRegistry.getProviderAuth('lmm'));
        if (ownerSession && ownerSession !== resolved.session) throw new LmmError('unauthorized', 'The LMM account changed. Enable a new remote session.');
        ownerSession = resolved.session;
        const auth = resolved.value;
        return auth?.auth.headers ? bearerFromHeaders(auth.auth.headers) : undefined;
      },
      metadata: () => ({ started_at: startedAt, runtime: 'Pi', directory: ctx.cwd,
        summary: 'Pi remote session', capabilities: ['prompt', 'abort', 'ui_response', 'ui_input'],
        provider: context?.model?.provider, model: context?.model?.id }),
      onCommand: dispatch,
      onHeartbeat: publishState,
      onStatus: (state, error) => {
        if (client !== remote) return;
        ctx.ui.setStatus('lmm-remote', state === 'connected' ? 'Remote: on' : state === 'retrying' ? 'Remote: reconnecting' : undefined);
        if (state === 'stopped') bridge.dispose();
        if (error && state === 'stopped') notify(error, 'warning');
      },
    });
    client = remote;
    try {
      await remote.start();
      if (current !== generation) { await remote.stop(); return; }
      bridge.install(ctx.ui);
      publishState();
      notify(`Remote control is on for this Pi session, with any model.\n${http.issuer}/remote-control\nPIN: ${remote.pin}\nUse /lmm-remote off to stop.`);
    } catch {
      if (client === remote) { client = undefined; bridge.dispose(); }
      await remote.stop();
      notify('Remote control could not connect. Use /login lmm, approve remote control, then run /lmm-remote on. Local Pi is unchanged.', 'warning');
    }
  }
  async function persist(value: boolean) {
    await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 });
    await writeFile(settingsPath, `${JSON.stringify({ enabled: value })}\n`, { mode: 0o600 });
    enabled = value;
  }
  pi.registerCommand('lmm-remote', {
    description: 'Enable, stop, or inspect encrypted remote control with any Pi model: on | off | status.',
    async handler(args, ctx) {
      context = ctx;
      if (!ctx.hasUI) return;
      const action = args.trim() || 'status';
      if (action === 'off') { await persist(false); await stop(); notify('Remote control is off. Local Pi remains available.'); return; }
      if (action === 'status') {
        notify(client?.active ? `Remote control is on.\n${http.issuer}/remote-control\nPIN: ${client.pin}` : 'Remote control is off. Sign in with /login lmm, then run /lmm-remote on.');
        return;
      }
      if (action !== 'on') { notify('Use /lmm-remote on, /lmm-remote off, or /lmm-remote status.', 'warning'); return; }
      if (client?.active || enabling) return;
      if (!enabled && !await ctx.ui.confirm('Enable remote control', 'Allow your LMM account and this session PIN to send tasks, stop work and answer plugin questions? This applies to any model. Future interactive sessions reconnect until you turn it off.')) return;
      enabling = (async () => { await connect(ctx); if (client?.active) await persist(true); })();
      try { await enabling; } finally { enabling = undefined; }
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    await stop();
    context = ctx;
    busy = !ctx.isIdle();
    try { const saved: unknown = JSON.parse(await readFile(settingsPath, 'utf8')); enabled = remoteRecord(saved) && saved.enabled === true; }
    catch { enabled = false; }
    if (enabled && ctx.hasUI) await connect(ctx);
  });
  pi.on('model_select', (_event, ctx) => { context = ctx; publishState(); });
  pi.on('agent_start', (_event, ctx) => { context = ctx; busy = true; publishState(); });
  pi.on('agent_end', (_event, ctx) => { context = ctx; busy = false; publishState(); });
  pi.on('message_start', () => { messageId = remoteId(); lastStreamAt = 0; });
  function mirror(message: unknown, id: string) {
    if (!client?.active || !remoteRecord(message)) return;
    const role = message.role;
    if (role !== 'assistant' && role !== 'user' && role !== 'toolResult') return;
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
    const content = blocks.flatMap((block) => remoteRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
    if (content) client.publish({ type: role === 'toolResult' ? 'tool_result' : role,
      id, content: boundedText(content), tool_name: message.toolName });
  }
  pi.on('message_update', (event) => {
    if (Date.now() - lastStreamAt < 750) return;
    lastStreamAt = Date.now();
    mirror(event.message, messageId);
  });
  pi.on('message_end', (event) => mirror(event.message, messageId));
  pi.on('tool_execution_start', (event) => {
    client?.publish({ type: 'tool_call', id: `tool-${event.toolCallId}`, tool_name: event.toolName,
      content: boundedText(event.args) });
  });
  pi.on('session_shutdown', async () => { await stop(); context = undefined; });
}
