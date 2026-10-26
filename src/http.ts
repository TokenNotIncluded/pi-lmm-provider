import { LmmError, boundedSignal, object, requireValue } from "./protocol.ts";

/** Retry-After accepts delay seconds or an HTTP date; ignore malformed hints. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const raw = value.trim();
  const ms = /^\d+$/.test(raw) ? Number(raw) * 1_000 : Date.parse(raw) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 2_147_483_647) : undefined;
}

/** Shared bounded error decoding; upstream text must never become a user-facing message. */
export async function httpResponseError(response: Response, signal: AbortSignal): Promise<LmmError> {
  let errorCode = '';
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json' && response.body) {
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        bytes += value.byteLength;
        requireValue(bytes <= 64_000, 'LMM error response exceeded its size limit.');
        chunks.push(value);
      }
      const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (typeof body.error === 'object' && body.error !== null && !Array.isArray(body.error) && typeof (body.error as Record<string, unknown>).code === 'string') {
        errorCode = (body.error as Record<string, unknown>).code as string;
      } else if (typeof body.code === 'string') {
        errorCode = body.code;
      }
    } catch {
      // Malformed, oversized or timed-out bodies retain safe status-only classification.
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    await response.body?.cancel().catch(() => {});
  }
  if (errorCode === 'IP_ACCESS_ROUTE_REJECTED') {
    return new LmmError('ip_policy', 'LMM request was blocked by the current IP access policy. Change network or ask the administrator to allow this IP.');
  }
  if (response.status === 401 || response.status === 403) {
    return new LmmError('unauthorized', 'LMM authorization is unavailable or was revoked. Use /login; no API-key fallback is allowed.');
  }
  if (response.status === 429) {
    return new LmmError('rate_limited', 'LMM rate limit reached. Wait a moment and retry.', retryAfterMs(response.headers.get('retry-after')));
  }
  if (response.status >= 500) {
    return new LmmError('upstream_unavailable', `LMM service is temporarily unavailable (HTTP ${response.status}). Try again shortly.`);
  }
  return new LmmError('http_error', `LMM HTTP request failed (${response.status}).`);
}

export interface HttpOptions {
  issuer?: string;
  fetch?: typeof globalThis.fetch;
  /** Local mock servers only; never set by the extension or any environment flag. */
  allowLoopbackHttpForTests?: boolean;
  timeoutMs?: number;
}

export class LmmHttp {
  readonly issuer: string;
  readonly resource: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;

  constructor(options: HttpOptions = {}) {
    const raw = options.issuer ?? "https://api.lmm.best";
    const url = new URL(raw);
    requireValue(
      !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/",
      "LMM issuer must be a trusted HTTPS origin without a path or credentials.",
    );
    requireValue(
      url.protocol === "https:" ||
        (options.allowLoopbackHttpForTests === true &&
          url.protocol === "http:" &&
          url.hostname === "127.0.0.1"),
      "LMM requires HTTPS (except explicit local test fixtures).",
    );
    this.issuer = url.origin;
    this.resource = `${this.issuer}/api/oauth2`;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request(
    path: string,
    init: RequestInit = {},
    maxBytes = 2_000_000,
  ): Promise<Record<string, unknown>> {
    const signal = boundedSignal(init.signal ?? undefined, this.timeoutMs);
    try {
      const response = await this.fetch(`${this.issuer}${path}`, {
        ...init,
        signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: { accept: "application/json", ...init.headers },
      });
      if (!response.ok) {
        throw await httpResponseError(response, signal);
      }
      if (response.status === 204 || path === "/api/oauth2/revoke") {
        await response.body?.cancel();
        return {};
      }
      const isJson = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
      if (!isJson) await response.body?.cancel().catch(() => {});
      requireValue(isJson);
      requireValue(response.body);
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          bytes += value.byteLength;
          requireValue(
            bytes <= maxBytes,
            "LMM response exceeded its size limit.",
          );
          chunks.push(value);
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      if (error instanceof LmmError) throw error;
      if (signal.aborted)
        throw new LmmError("aborted", "LMM request cancelled or timed out.");
      throw new LmmError(
        "transport_error",
        "LMM network request failed. Check your connection and retry.",
      );
    }
  }

  form(
    path: string,
    fields: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.request(
      path,
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      },
      64_000,
    );
  }

  bearer(
    path: string,
    access: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.request(path, {
      headers: { authorization: `Bearer ${access}` },
      signal,
    });
  }
}
