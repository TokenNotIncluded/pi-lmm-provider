import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bundledMetadata, MODELS_DEV_URL, parseMetadataCatalog, type MetadataSnapshot } from './models-dev.ts';

const TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * MAX_BYTES + 4096;

interface CacheFile {
  version: 1;
  fetchedAt: string;
  sourceSha256: string;
  catalog: string;
}

export interface ModelMetadataCacheOptions {
  fetch?: typeof fetch;
  directory?: string;
  now?: () => number;
  timeoutMs?: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Public metadata only: never sends account credentials, endpoint URLs, or model names. */
export class ModelMetadataCache {
  private current: MetadataSnapshot = bundledMetadata;
  private fetchedAt = -Infinity;
  private retryAt = -Infinity;
  private inFlight?: Promise<void>;
  private readonly fetcher: typeof fetch;
  private readonly directory: string;
  private readonly file: string;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: ModelMetadataCacheOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.directory = options.directory ?? join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'lmm-models-dev');
    this.file = join(this.directory, 'catalog-v1.json');
    this.now = options.now ?? Date.now;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(options.timeoutMs!, 5000)) : 5000;
    this.readLocal();
  }

  get snapshot(): MetadataSnapshot { return this.current; }

  private readLocal(): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.file, 'r');
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return;
      // Read through the opened descriptor, capped even if the file changes concurrently.
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length !== stat.size) return;
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as Partial<CacheFile> | null;
      if (!data || data.version !== 1 || typeof data.fetchedAt !== 'string' ||
          typeof data.catalog !== 'string' || typeof data.sourceSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(data.sourceSha256) || Buffer.byteLength(data.catalog) > MAX_BYTES) return;
      const fetchedAt = Date.parse(data.fetchedAt);
      if (!Number.isFinite(fetchedAt) || fetchedAt > this.now() || sha256(data.catalog) !== data.sourceSha256) return;
      this.current = parseMetadataCatalog(JSON.parse(data.catalog), data.fetchedAt, data.sourceSha256);
      this.fetchedAt = fetchedAt;
    } catch { /* Missing or corrupt disk data falls back to the bundled catalog. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  refresh(signal?: AbortSignal, force = false): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (!force && (now - this.fetchedAt < TTL_MS || now < this.retryAt)) return Promise.resolve();
    this.inFlight = this.update(signal).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async update(signal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('models.dev request timed out')), this.timeoutMs);
    try {
      const cancelled = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      if (signal?.aborted) abort();
      // Race also bounds injected fetch implementations that ignore AbortSignal.
      const catalog = await Promise.race([this.download(controller.signal), cancelled]);
      controller.signal.throwIfAborted();
      clearTimeout(timer);
      const fetchedAt = this.now();
      const data: CacheFile = { version: 1, fetchedAt: new Date(fetchedAt).toISOString(), sourceSha256: sha256(catalog), catalog };
      const parsed = parseMetadataCatalog(JSON.parse(catalog), data.fetchedAt, data.sourceSha256);
      this.current = parsed;
      this.fetchedAt = fetchedAt;
      this.retryAt = -Infinity;
      await this.persist(data);
    } catch {
      if (!signal?.aborted) this.retryAt = this.now() + RETRY_MS;
      // Keep verified stale metadata on timeout, network failure, or invalid input.
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async download(signal: AbortSignal): Promise<string> {
    const response = await this.fetcher(MODELS_DEV_URL, {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', credentials: 'omit', signal,
    });
    if (signal.aborted) {
      void response.body?.cancel(signal.reason).catch(() => {});
      signal.throwIfAborted();
    }
    const contentType = response.headers.get('content-type') ?? '';
    const length = response.headers.get('content-length');
    if (!response.ok || response.redirected || (response.url && response.url !== MODELS_DEV_URL) ||
        !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType) ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Invalid models.dev response');
    }
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) throw new Error('models.dev response is too large');
        chunks.push(chunk.value);
      }
      signal.throwIfAborted();
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    } finally {
      signal.removeEventListener('abort', cancel);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private async persist(data: CacheFile): Promise<void> {
    const temporary = join(this.directory, `.catalog-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } catch { /* Read-only disks must not discard valid metadata already in memory. */ }
    finally { await unlink(temporary).catch(() => {}); }
  }
}
