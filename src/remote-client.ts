import { setTimeout as delay } from 'node:timers/promises';
import { LmmHttp } from './http.ts';
import { LmmError } from './protocol.ts';
import { REMOTE_PATH, decryptRemote, deriveRemoteKey, encryptRemote, parseRemoteCommand,
  remoteAad, remoteId, remotePin, remoteRecord, type RemoteCommand, type RemoteEvent } from './remote-wire.ts';

export interface RemoteClientOptions {
  http: LmmHttp;
  getAccessToken: () => Promise<string | undefined>;
  metadata: () => Record<string, unknown>;
  /** Dispatch MUST NOT wait for a model turn or a UI answer. Polling must remain live. */
  onCommand: (command: RemoteCommand) => void;
  onHeartbeat?: () => void;
  onStatus?: (state: 'connected' | 'retrying' | 'stopped', error?: string) => void;
  pollMs?: number;
  heartbeatMs?: number;
}

export class RemoteClient {
  readonly sessionId = remoteId();
  readonly deviceId = remoteId();
  readonly pin = remotePin();
  private key?: CryptoKey;
  private readonly shutdown = new AbortController();
  private readonly queue: RemoteEvent[] = [];
  private readonly seen = new Map<string, number>();
  private cursor = 0;
  private generation?: string;
  private heartbeatAt = 0;
  private connected = false;
  private access?: string;
  private loop?: Promise<void>;
  private readonly options: RemoteClientOptions;

  constructor(options: RemoteClientOptions) { this.options = options; }
  get active(): boolean { return !!this.key && !this.shutdown.signal.aborted; }
  get pendingCount(): number { return this.queue.length; }
  async start(): Promise<void> {
    if (this.key || this.shutdown.signal.aborted) return;
    this.key = await deriveRemoteKey(this.pin, this.sessionId);
    await this.heartbeat();
    if (this.shutdown.signal.aborted) return;
    this.loop = this.run();
  }
  /** Snapshot IDs coalesce while offline; ordinary event memory is bounded too. */
  publish(event: RemoteEvent): void {
    if (this.shutdown.signal.aborted) return;
    const value = { ...event, id: event.id ?? remoteId(), created_at: event.created_at ?? Date.now() };
    if (Buffer.byteLength(JSON.stringify(value)) > 48 * 1024) {
      this.options.onStatus?.('retrying', 'A remote event exceeded the size limit; inspect the local terminal.');
      return;
    }
    const index = this.queue.findIndex((entry) => entry.id === value.id);
    if (value.type === 'ack' || value.type === 'state') {
      if (index >= 0) this.queue.splice(index, 1);
      if (this.queue.length >= 128) this.queue.pop();
      this.queue.unshift(value);
    } else if (index >= 0) this.queue[index] = value;
    else {
      if (this.queue.length >= 128) this.queue.shift();
      this.queue.push(value);
    }
  }
  async stop(): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    this.shutdown.abort();
    this.queue.length = 0;
    this.seen.clear();
    this.key = undefined;
    this.options.onStatus?.('stopped');
    await this.loop;
    if (this.access) {
      try {
        await this.options.http.request(`${REMOTE_PATH}/${this.sessionId}`, {
          method: 'DELETE', headers: { authorization: `Bearer ${this.access}` }, signal: AbortSignal.timeout(3_000),
        });
      } catch { /* The server also expires abandoned sessions after two minutes. */ }
    }
    this.access = undefined;
  }
  private async request(path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
    this.shutdown.signal.throwIfAborted();
    const token = await this.options.getAccessToken();
    this.shutdown.signal.throwIfAborted();
    if (!token) throw new LmmError('unauthorized', 'Sign in with /login lmm, then run /lmm-remote on.');
    this.access = token;
    const result = await this.options.http.request(`${REMOTE_PATH}/${this.sessionId}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: this.shutdown.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, 12 * 1024 * 1024);
    if (result.success !== true) throw new LmmError('remote_error', 'The remote relay rejected the request.');
    return result;
  }
  private async heartbeat(): Promise<void> {
    if (!this.key) return;
    const metadata = await encryptRemote(this.key, { ...this.options.metadata(), version: 1 },
      remoteAad(this.sessionId, 'metadata', this.deviceId), 15 * 1024);
    const result = await this.request('', 'PUT', { device_id: this.deviceId, metadata });
    if (remoteRecord(result.data) && typeof result.data.generation === 'string') {
      if (this.generation !== result.data.generation) {
        this.generation = result.data.generation;
        this.cursor = 0;
        this.connected = false;
      }
    }
    this.heartbeatAt = Date.now();
    this.options.onHeartbeat?.();
    if (!this.connected) {
      this.connected = true;
      this.options.onStatus?.('connected');
    }
  }
  private async flush(): Promise<void> {
    // Never let a burst of model output starve incoming stop/UI commands.
    for (let count = 0; count < 8 && this.queue.length && this.key; count++) {
      const event = this.queue[0];
      const encrypted = await encryptRemote(this.key, event, remoteAad(this.sessionId, 'message', 'plugin'));
      await this.request('/messages', 'POST', { sender: 'plugin', ...encrypted });
      // A same-ID snapshot can be replaced while fetch is in flight.
      if (this.queue[0] === event) this.queue.shift();
    }
  }
  private async poll(): Promise<void> {
    const result = await this.request(`/messages?after=${this.cursor}`);
    const messages = remoteRecord(result.data) ? result.data.messages : undefined;
    if (!Array.isArray(messages) || messages.length > 128) throw new LmmError('remote_error', 'Invalid remote message list.');
    for (const envelope of messages) {
      if (!remoteRecord(envelope) || typeof envelope.sequence !== 'number' || !Number.isSafeInteger(envelope.sequence) || envelope.sequence <= this.cursor) continue;
      this.cursor = envelope.sequence;
      if (envelope.sender !== 'controller' || !this.key) continue;
      try {
        const payload = await decryptRemote(this.key, envelope, remoteAad(this.sessionId, 'message', 'controller'));
        const command = parseRemoteCommand(payload);
        if (!command) continue;
        const now = Date.now();
        for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
        if (this.seen.has(command.id)) continue;
        // Refuse, rather than evict live IDs and permit a replay flood.
        if (this.seen.size >= 2048) continue;
        this.seen.set(command.id, now + 300_000);
        this.options.onCommand(command);
      } catch {
        // One malformed/foreign ciphertext must not block later valid messages.
      }
    }
  }
  private async run(): Promise<void> {
    let failures = 0;
    while (!this.shutdown.signal.aborted) {
      try {
        if (Date.now() - this.heartbeatAt >= (this.options.heartbeatMs ?? 20_000)) await this.heartbeat();
        await this.poll();
        await this.flush();
        failures = 0;
        await delay(this.options.pollMs ?? 1_000, undefined, { signal: this.shutdown.signal, ref: false });
      } catch (error) {
        if (this.shutdown.signal.aborted) break;
        this.connected = false;
        this.heartbeatAt = 0;
        if (error instanceof LmmError && error.code === 'unauthorized') {
          this.options.onStatus?.('stopped', 'Remote authorization is unavailable. Use /login lmm and approve remote control again.');
          // Do not await stop() here: it waits for this loop.
          this.shutdown.abort();
          this.key = undefined;
          this.queue.length = 0;
          this.access = undefined;
          break;
        }
        this.options.onStatus?.('retrying', 'Remote connection interrupted; local Pi remains available.');
        try { await delay(Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5)), undefined, { signal: this.shutdown.signal, ref: false }); }
        catch { break; }
      }
    }
  }
}
