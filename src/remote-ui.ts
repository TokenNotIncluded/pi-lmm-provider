import { ExtensionEditorComponent, type ExtensionUIContext, type ExtensionUIDialogOptions,
  type Theme, type KeybindingsManager } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { REMOTE_KEYS, remoteId, type RemoteCommand, type RemoteEvent } from './remote-wire.ts';

type CustomComponent = Component & { dispose?(): void };
type CustomFactory<T> = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => CustomComponent | Promise<CustomComponent>;
type CustomOptions = Parameters<ExtensionUIContext['custom']>[1];
type Pending = { message: RemoteEvent; cancel?: () => void; answer?: (command: RemoteCommand) => void; input?: (command: RemoteCommand) => void };

/** Attach to Pi's shared UI context, not to one tool name or model provider. */
export class RemoteUiBridge {
  private readonly pending = new Map<string, Pending>();
  private restore?: () => void;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private ui?: ExtensionUIContext;
  private readonly isActive: () => boolean;
  private readonly changed: () => void;
  constructor(isActive: () => boolean, changed: () => void) { this.isActive = isActive; this.changed = changed; }
  snapshot(): RemoteEvent[] { return [...this.pending.values()].map((item) => ({ ...item.message })); }
  respond(command: RemoteCommand): void {
    const pending = command.request_id ? this.pending.get(command.request_id) : undefined;
    if (!this.isActive() || !pending) throw new Error('This question is no longer waiting for an answer.');
    if (typeof pending.message.expires_at === 'number' && Date.now() >= pending.message.expires_at) throw new Error('This question has expired.');
    const handler = command.action === 'ui_input' ? pending.input : pending.answer;
    if (!handler) throw new Error('This answer does not match the current question.');
    handler(command);
  }
  cancelAll(): void { for (const pending of [...this.pending.values()]) pending.cancel?.(); }
  install(ui: ExtensionUIContext): void {
    if (this.ui === ui) return;
    this.dispose();
    this.ui = ui;
    const originals = { select: ui.select, confirm: ui.confirm, input: ui.input, custom: ui.custom, editor: ui.editor };
    const select: ExtensionUIContext['select'] = (title, options, opts) => {
      if (!this.isActive() || this.pending.size >= 4) return originals.select.call(ui, title, options, opts);
      return this.dialog({ kind: 'select', question: title, options: options.slice(0, 40).map((value) => value.slice(0, 32)) },
        (signal) => originals.select.call(ui, title, options, { ...opts, signal }),
        (command) => { if (command.cancelled) return undefined;
          if (typeof command.value === 'number' && Number.isInteger(command.value) && command.value >= 0 && command.value < options.length) return options[command.value];
          if (typeof command.value !== 'string' || !options.includes(command.value)) throw new Error('Select one of the offered answers.');
          return command.value; }, opts);
    };
    const confirm: ExtensionUIContext['confirm'] = (title, message, opts) => {
      if (!this.isActive() || this.pending.size >= 4) return originals.confirm.call(ui, title, message, opts);
      return this.dialog({ kind: 'confirm', title, question: message },
        (signal) => originals.confirm.call(ui, title, message, { ...opts, signal }),
        (command) => { if (command.cancelled) return false;
          if (typeof command.value !== 'boolean') throw new Error('A confirmation must be yes or no.');
          return command.value; }, opts);
    };
    const input: ExtensionUIContext['input'] = (title, placeholder, opts) => {
      if (!this.isActive() || this.pending.size >= 4) return originals.input.call(ui, title, placeholder, opts);
      return this.dialog({ kind: 'input', question: title, placeholder },
        (signal) => originals.input.call(ui, title, placeholder, { ...opts, signal }),
        (command) => { if (command.cancelled) return undefined;
          if (typeof command.value !== 'string') throw new Error('A text answer is required.');
          return command.value; }, opts);
    };
    const custom: ExtensionUIContext['custom'] = <T>(factory: CustomFactory<T>, options?: CustomOptions) => {
      if (!this.isActive() || this.pending.size >= 4) return originals.custom.call(ui, factory, options) as Promise<T>;
      return this.custom<T>(ui, originals.custom, factory, options);
    };
    const editor: ExtensionUIContext['editor'] = (title, prefill) => {
      if (!this.isActive()) return originals.editor.call(ui, title, prefill);
      // Use Pi's public editor component, preserving local keyboard/editing behavior.
      // A custom component has a real done() path; racing the original editor would
      // leave a stale local dialog open after a remote answer.
      return custom<string | undefined>((tui, _theme, keys, done) =>
        new ExtensionEditorComponent(tui, keys, title, prefill, done, () => done(undefined)));
    };
    const installed = { select, confirm, input, custom, editor };
    Object.assign(ui, installed);
    this.restore = () => {
      // Never overwrite a later wrapper installed by another extension.
      for (const key of Object.keys(originals) as (keyof typeof originals)[]) {
        if (ui[key] === installed[key]) Object.assign(ui, { [key]: originals[key] });
      }
    };
  }
  dispose(): void {
    this.restore?.();
    this.restore = undefined;
    this.ui = undefined;
    this.pending.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    // Disabling remote control does not dismiss a local user dialog.
  }
  private dialog<T>(fields: Record<string, unknown>, local: (signal: AbortSignal) => Promise<T>,
    decode: (command: RemoteCommand) => T, options?: ExtensionUIDialogOptions): Promise<T> {
    const id = remoteId();
    const abort = new AbortController();
    const signal = options?.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    const message: RemoteEvent = { type: 'ask_user', id, request_id: id, ...fields,
      ...(options?.timeout !== undefined ? { expires_at: Date.now() + options.timeout } : {}) };
    for (const key of ['title', 'question', 'placeholder']) if (typeof message[key] === 'string') message[key] = message[key].slice(0, 1_000);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const close = () => { this.pending.delete(id); this.changed(); };
      const finish = (value: T, remote = false) => {
        if (settled) return;
        settled = true;
        resolve(value);
        close();
        if (remote) abort.abort();
      };
      this.pending.set(id, { message, answer: (command) => finish(decode(command), true),
        cancel: () => finish(decode({ version: 1, type: 'command', action: 'ui_response', id: remoteId(), issued_at: Date.now(), request_id: id, cancelled: true }), true) });
      this.changed();
      try { Promise.resolve(local(signal)).then((value) => finish(value), (error) => {
        if (!settled) { settled = true; close(); reject(error); }
      }); } catch (error) { settled = true; close(); reject(error); }
    });
  }
  private custom<T>(ui: ExtensionUIContext, original: ExtensionUIContext['custom'], factory: CustomFactory<T>, options?: CustomOptions): Promise<T> {
    const id = remoteId();
    const pending: Pending = { message: { type: 'ask_user', id, request_id: id, kind: 'custom',
      question: 'Pi extension interaction', content: 'Waiting for the terminal view…' } };
    this.pending.set(id, pending);
    this.changed();
    const factoryWrapper: CustomFactory<T> = async (tui, theme, keybindings, done) => {
      let closed = false;
      const finish = (value: T) => {
        if (closed) return;
        closed = true;
        if (this.pending.get(id) === pending) { this.pending.delete(id); this.changed(); }
        // The local dialog must still finish after remote control is disabled.
        done(value);
      };
      pending.cancel = () => finish(undefined as T);
      const component = await factory(tui, theme, keybindings, finish);
      let lastFrame = '';
      let lastSent = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const send = () => {
        if (timer) { this.timers.delete(timer); timer = undefined; }
        if (this.pending.get(id) !== pending || !this.isActive()) return;
        pending.message.content = lastFrame;
        lastSent = Date.now();
        this.changed();
      };
      pending.input = (command) => {
        if (!component.handleInput) throw new Error('This view does not accept keyboard input.');
        const data = command.key ? REMOTE_KEYS[command.key] : `\x1b[200~${command.text ?? ''}\x1b[201~`;
        component.handleInput(data);
        tui.requestRender();
      };
      return new Proxy(component, {
        get(target, property) {
          if (property === 'render') return (width: number) => {
            const lines = target.render(width);
            const frame = lines.slice(0, 160).map((line) => stripVTControlCharacters(line)).join('\n').slice(0, 2_000);
            if (frame !== lastFrame) {
              lastFrame = frame;
              if (Date.now() - lastSent >= 200) send();
              else if (!timer) {
                timer = setTimeout(send, 200);
                timer.unref?.();
                thisBridge.timers.add(timer);
              }
            }
            return lines;
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const thisBridge = this;
    try {
      return (original.call(ui, factoryWrapper, options) as Promise<T>).finally(() => {
        this.pending.delete(id);
        this.changed();
      });
    } catch (error) { this.pending.delete(id); this.changed(); throw error; }
  }
}
