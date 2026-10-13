import { setTimeout as delay } from 'node:timers/promises';
import { LmmHttp } from './http.ts';
import { LmmError } from './protocol.ts';
import { readRemoteStream } from './remote-stream.ts';
import { REMOTE_PATH, decryptRemote, deriveRemoteKey, encryptRemote, parseRemoteCommand,
  remoteAad, remoteId, remotePin, remoteRecord, type RemoteCommand, type RemoteEvent } from './remote-wire.ts';

export interface RemoteClientOptions {
  http: LmmHttp;
  getAccessToken: () => Promise<string | undefined>;
  metadata: () => Record<string, unknown>;
  /** Dispatch MUST NOT wait for a model turn or a UI answer. */
  onCommand: (command: RemoteCommand) => void;
  onHeartbeat?: () => void;
  onStatus?: (state: 'connected' | 'retrying' | 'stopped', error?: string) => void;
  heartbeatMs?: number;
}

/** Isolate local callbacks, including accidental promises, from both transport loops. */
function callback(run: () => unknown): void {
  try { void Promise.resolve(run()).catch(() => {}); } catch { /* Local UI failures are not transport failures. */ }
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
  private inbound?: Promise<void>;
  private outbound?: Promise<void>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private sleeping?: AbortController;
  private registration?: { promise: Promise<void>; resolve: () => void };
  private acceptReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private readonly options: RemoteClientOptions;

  constructor(options: RemoteClientOptions) { this.options = options; }
  get active(): boolean { return !!this.key && !this.shutdown.signal.aborted; }
  get isConnected(): boolean { return this.connected && this.active; }
  get pendingCount(): number { return this.queue.length; }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.shutdown.signal.aborted) return Promise.reject(new LmmError('aborted', 'Remote control stopped.'));
    this.starting = this.initialize();
    return this.starting;
  }
  private async initialize(): Promise<void> {
    const key = await deriveRemoteKey(this.pin, this.sessionId);
    this.shutdown.signal.throwIfAborted();
    this.key = key;
    try {
      await this.heartbeat();
      this.shutdown.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.terminate('Remote event-stream startup timed out. Local Pi remains available.');
        }, this.options.http.timeoutMs);
        timer.unref();
        const aborted = () => reject(new LmmError('aborted', 'Remote control stopped before event-stream readiness.'));
        this.shutdown.signal.addEventListener('abort', aborted, { once: true });
        const finish = () => {
          clearTimeout(timer);
          this.shutdown.signal.removeEventListener('abort', aborted);
          this.acceptReady = undefined; this.rejectReady = undefined;
        };
        this.acceptReady = () => { finish(); resolve(); };
        this.rejectReady = (error) => { finish(); reject(error); };
        // The abort listener also clears the startup timer and deferred callbacks.
        this.shutdown.signal.addEventListener('abort', finish, { once: true });
        this.inbound = this.receive();
        this.outbound = this.send();
      });
    } catch (error) {
      if (!this.shutdown.signal.aborted) this.terminate('Remote control could not start. Local Pi remains available.',
        error instanceof LmmError && error.code === 'unauthorized');
      throw error;
    }
  }
  private status(state: 'connected' | 'retrying' | 'stopped', error?: string): void {
    if (this.shutdown.signal.aborted && state !== 'stopped') return;
    callback(() => this.options.onStatus?.(state, error));
  }
  private terminate(message: string, unauthorized = false): void {
    if (this.shutdown.signal.aborted) return;
    this.rejectReady?.(new LmmError(unauthorized ? 'unauthorized' : 'remote_error', message));
    this.shutdown.abort(); this.key = undefined; this.queue.length = 0; this.seen.clear();
    if (unauthorized) this.access = undefined;
    this.status('stopped', message);
  }
  /** Snapshot IDs coalesce while offline; ordinary event memory is bounded too. */
  publish(event: RemoteEvent): void {
    if (this.shutdown.signal.aborted) return;
    const wasEmpty = this.queue.length === 0;
    const value = { ...event, id: event.id ?? remoteId(), created_at: event.created_at ?? Date.now() };
    if (Buffer.byteLength(JSON.stringify(value)) > 48 * 1024) {
      this.status('retrying', 'A remote event exceeded the size limit; inspect the local terminal.');
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
    // Preserves the pre-existing outbound wake and hard-cooldown behavior.
    if (wasEmpty) this.sleeping?.abort();
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.shutdown.signal.aborted) this.terminate('');
    this.stopping = this.cleanup();
    return this.stopping;
  }
  private async cleanup(): Promise<void> {
    await Promise.allSettled([this.starting, this.inbound, this.outbound]);
    if (this.access) {
      try {
        await this.options.http.request(`${REMOTE_PATH}/${this.sessionId}`, {
          method: 'DELETE', headers: { authorization: `Bearer ${this.access}` }, signal: AbortSignal.timeout(3_000),
        });
      } catch { /* The server also expires abandoned sessions after two minutes. */ }
    }
    this.access = undefined;
  }
  private async token(): Promise<string> {
    this.shutdown.signal.throwIfAborted();
    const token = await new Promise<string | undefined>((resolve, reject) => {
      const aborted = () => reject(new LmmError('aborted', 'Remote control stopped.'));
      this.shutdown.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => this.options.getAccessToken()).then(resolve, reject)
        .finally(() => this.shutdown.signal.removeEventListener('abort', aborted));
    });
    this.shutdown.signal.throwIfAborted();
    if (!token) throw new LmmError('unauthorized', 'Remote authorization is unavailable.');
    this.access = token;
    return token;
  }
  private async request(path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = await this.token();
    const result = await this.options.http.request(`${REMOTE_PATH}/${this.sessionId}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: this.shutdown.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, 12 * 1024 * 1024);
    this.shutdown.signal.throwIfAborted();
    if (result.success !== true) throw new LmmError('remote_error', 'The remote relay rejected the request.');
    return result;
  }
  private async heartbeat(): Promise<void> {
    if (!this.key) return;
    const metadata = await encryptRemote(this.key, { ...this.options.metadata(), version: 1 },
      remoteAad(this.sessionId, 'metadata', this.deviceId), 15 * 1024);
    await this.request('', 'PUT', { device_id: this.deviceId, metadata });
    // Only stream ready is authoritative for generation/cursor and connection state.
    this.heartbeatAt = Date.now();
    if (!this.shutdown.signal.aborted) callback(() => this.options.onHeartbeat?.());
  }
  private async flush(): Promise<void> {
    for (let count = 0; count < 8 && this.queue.length && this.key; count++) {
      const event = this.queue[0];
      const encrypted = await encryptRemote(this.key, event, remoteAad(this.sessionId, 'message', 'plugin'));
      await this.request('/messages', 'POST', { sender: 'plugin', ...encrypted });
      if (this.queue[0] === event) this.queue.shift();
    }
  }
  private async messages(messages: unknown[]): Promise<void> {
    // Sort a bounded copy: a malformed high sequence must not hide valid later entries.
    const ordered = messages.filter((entry) => remoteRecord(entry) && Number.isSafeInteger(entry.sequence) && Number(entry.sequence) > 0)
      .sort((a, b) => Number((a as Record<string, unknown>).sequence) - Number((b as Record<string, unknown>).sequence));
    for (const envelope of ordered) {
      if (this.shutdown.signal.aborted) return;
      if (!remoteRecord(envelope) || Number(envelope.sequence) <= this.cursor) continue;
      if (envelope.sender !== 'controller' || !this.key) continue;
      try {
        const payload = await decryptRemote(this.key, envelope, remoteAad(this.sessionId, 'message', 'controller'));
        if (this.shutdown.signal.aborted) return;
        this.cursor = Number(envelope.sequence);
        const command = parseRemoteCommand(payload);
        if (!command) continue;
        const now = Date.now();
        for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
        if (this.seen.has(command.id) || this.seen.size >= 2048) continue;
        this.seen.set(command.id, now + 300_000);
        callback(() => this.options.onCommand(command));
      } catch { /* One malformed/foreign ciphertext must not block later valid messages. */ }
    }
  }
  /** Reconnection waits for the serial outbound scheduler, including its hard cooldown. */
  private async renewRegistration(): Promise<void> {
    this.shutdown.signal.throwIfAborted();
    if (!this.registration) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      this.registration = { promise, resolve };
      this.sleeping?.abort();
    }
    const registration = this.registration;
    const aborted = () => registration.resolve();
    this.shutdown.signal.addEventListener('abort', aborted, { once: true });
    try {
      await registration.promise;
      this.shutdown.signal.throwIfAborted();
    } finally { this.shutdown.signal.removeEventListener('abort', aborted); }
  }
  private async receive(): Promise<void> {
    let failures = 0;
    let replacement: string | undefined;
    let rotated = false;
    while (!this.shutdown.signal.aborted) {
      let usedToken: string | undefined;
      let ready = false;
      try {
        usedToken = replacement ?? await this.token(); replacement = undefined;
        const query = new URLSearchParams({ after: String(this.cursor), generation: this.generation ?? '' });
        await readRemoteStream(this.options.http, `${REMOTE_PATH}/${this.sessionId}/events?${query}`, usedToken,
          this.shutdown.signal, async (name, json) => {
            if (this.shutdown.signal.aborted) return false;
            if (name !== 'ready' && name !== 'messages' && name !== 'error') return false;
            const data: unknown = JSON.parse(json);
            if (name === 'error') {
              if (remoteRecord(data) && data.code === 'unauthorized') throw new LmmError('unauthorized', 'Remote authorization is unavailable.');
              throw new LmmError('remote_error', 'Remote stream unavailable.');
            }
            if (!remoteRecord(data) || typeof data.generation !== 'string' || !data.generation || data.generation.length > 128 ||
              !Array.isArray(data.messages) || data.messages.length > 128 || (name === 'messages' && !ready)) {
              throw new LmmError('remote_error', 'Invalid remote stream event.');
            }
            if (name === 'ready') {
              if (ready) throw new LmmError('remote_error', 'Duplicate remote readiness.');
              if (this.generation !== data.generation) { this.generation = data.generation; this.cursor = 0; }
              ready = true; rotated = false; failures = 0;
            } else if (this.generation !== data.generation) throw new LmmError('remote_error', 'Remote generation changed without readiness.');
            await this.messages(data.messages);
            if (this.shutdown.signal.aborted) return false;
            if (name === 'ready') {
              this.connected = true; this.status('connected'); this.acceptReady?.();
            }
            return name === 'ready';
          });
      } catch (error) {
        if (this.shutdown.signal.aborted) break;
        this.connected = false;
        if (error instanceof LmmError && error.code === 'unauthorized') {
          // An old stream token can expire while same-account OAuth has rotated.
          if (!rotated && usedToken) {
            rotated = true;
            try {
              const fresh = await this.token();
              if (fresh !== usedToken) { replacement = fresh; continue; }
            } catch { /* Missing/revoked/account-changed credentials terminate below. */ }
          }
          this.terminate('Remote authorization is unavailable. Use /login lmm and approve remote control again.', true);
          break;
        }
        if (error instanceof LmmError && error.code === 'remote_unsupported') {
          this.terminate('Remote control requires the event-stream relay. Upgrade/deploy the relay; polling fallback is disabled.');
          break;
        }
        this.status('retrying', 'Remote event stream interrupted; local Pi remains available.');
        if (!await this.backoff(error, failures++)) break;
        // A lost transport may mean a memory-only relay lost registration. Renew before
        // GET, not after a missing-session 404 has been mistaken for unsupported SSE.
        if (!(error instanceof LmmError) || (error.code !== 'rate_limited' && error.code !== 'ip_policy')) {
          try { await this.renewRegistration(); } catch { break; }
        }
      }
    }
  }
  private async backoff(error: unknown, failures: number): Promise<boolean> {
    const backoffMs = Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));
    const waitMs = error instanceof LmmError && error.code === 'rate_limited'
      ? Math.max(backoffMs, error.retryAfterMs ?? 30_000) : backoffMs;
    // Publishers and heartbeats must never interrupt a rate-limit cooldown.
    try { await delay(waitMs, undefined, { signal: this.shutdown.signal, ref: false }); return true; }
    catch { return false; }
  }
  private async send(): Promise<void> {
    let failures = 0;
    while (!this.shutdown.signal.aborted) {
      try {
        const registration = this.registration;
        if (registration || Date.now() - this.heartbeatAt >= (this.options.heartbeatMs ?? 30_000)) {
          await this.heartbeat();
          if (registration) {
            if (this.registration === registration) this.registration = undefined;
            registration.resolve();
          }
        }
        if (this.queue.length) {
          await this.flush();
          // Eight batches per pass; yield for fairness and coalesce microbursts.
          await delay(0, undefined, { signal: this.shutdown.signal, ref: false });
        }
        failures = 0;
        if (this.queue.length || this.registration) continue;
        const sleeping = new AbortController(); this.sleeping = sleeping;
        try {
          await delay(Math.max(1, this.heartbeatAt + (this.options.heartbeatMs ?? 30_000) - Date.now()), undefined,
            { signal: AbortSignal.any([this.shutdown.signal, sleeping.signal]), ref: false });
        } catch (error) { if (!sleeping.signal.aborted) throw error; }
        finally { if (this.sleeping === sleeping) this.sleeping = undefined; }
      } catch (error) {
        if (this.shutdown.signal.aborted) break;
        if (error instanceof LmmError && error.code === 'unauthorized') {
          this.terminate('Remote authorization is unavailable. Use /login lmm and approve remote control again.', true); break;
        }
        this.status('retrying', 'Remote reporting interrupted; incoming commands remain independent.');
        if (!await this.backoff(error, failures++)) break;
      }
    }
  }
}
