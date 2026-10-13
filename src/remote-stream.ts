import { LmmHttp, httpResponseError } from './http.ts';
import { LmmError } from './protocol.ts';

// 128 envelopes, each with at most 90,000 encoded ciphertext characters.
export const REMOTE_FRAME_BYTES = 12 * 1024 * 1024;
export const REMOTE_STREAM_WATCHDOG_MS = 20_000;

/** Authenticated stream only: never follow redirects or put credentials in URLs. */
export async function readRemoteStream(http: LmmHttp, path: string, token: string,
  signal: AbortSignal, onEvent: (name: string, data: string) => Promise<boolean>): Promise<void> {
  const connection = new AbortController();
  const combined = AbortSignal.any([signal, connection.signal]);
  let timer = setTimeout(() => connection.abort(), http.timeoutMs);
  timer.unref();
  let lease: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  combined.addEventListener('abort', cancel, { once: true });
  try {
    response = await http.fetch(`${http.issuer}${path}`, {
      method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: combined, redirect: 'error', credentials: 'omit', cache: 'no-store',
    });
    combined.throwIfAborted();
    if (!response.ok) {
      const error = await httpResponseError(response, combined);
      // Existing policy/auth/rate-limit precedence applies to both HTTP transports.
      if (error.code === 'ip_policy' || error.code === 'unauthorized' || error.code === 'rate_limited') throw error;
      if ([404, 405, 501].includes(response.status)) throw new LmmError('remote_unsupported', 'Remote control requires the event-stream relay. Upgrade/deploy the relay; polling fallback is disabled.');
      throw error;
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream' || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new LmmError('remote_unsupported', 'Remote control requires the event-stream relay. Upgrade/deploy the relay; polling fallback is disabled.');
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let lineParts: string[] = [];
    let name = '';
    let data: string[] = [];
    let frameBytes = 0;
    let frameLines = 0;
    let previousCR = false;
    let ready = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => connection.abort(), REMOTE_STREAM_WATCHDOG_MS);
      watchdog.unref();
    };
    async function consumeLine() {
      const line = lineParts.join(''); lineParts = [];
      if (++frameLines > 4096) throw new LmmError('remote_error', 'Remote stream frame exceeded its line limit.');
      if (!line) {
        if (data.length) {
          const accepted = await onEvent(name || 'message', data.join('\n'));
          combined.throwIfAborted();
          if (accepted && !ready) {
            ready = true;
            clearTimeout(timer);
            lease = setTimeout(() => connection.abort(), 75_000);
            lease.unref();
          }
        }
        name = ''; data = []; frameBytes = 0; frameLines = 0;
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') name = value;
        if (field === 'data') data.push(value);
      }
    }
    function append(part: string, delimiter = false) {
      frameBytes += Buffer.byteLength(part);
      if (frameBytes > REMOTE_FRAME_BYTES) throw new LmmError('remote_error', 'Remote stream frame exceeded its size limit.');
      if (part && !delimiter) lineParts.push(part);
    }
    try {
      armWatchdog();
      while (true) {
        combined.throwIfAborted();
        const { value, done } = await reader.read();
        combined.throwIfAborted();
        if (done) break;
        armWatchdog();
        // Slice before decoding: even a huge fetch chunk cannot bypass frame bounds.
        for (let offset = 0; offset < value.length; offset += 16_384) {
          const text = decoder.decode(value.subarray(offset, offset + 16_384), { stream: true });
          let start = 0;
          for (const match of text.matchAll(/[\r\n]/g)) {
            const index = match.index;
            if (previousCR && index === start && match[0] === '\n') {
              previousCR = false; start = index + 1; continue;
            }
            append(text.slice(start, index)); append(match[0], true);
            await consumeLine();
            previousCR = match[0] === '\r'; start = index + 1;
          }
          if (start < text.length) { append(text.slice(start)); previousCR = false; }
        }
      }
      decoder.decode(); // Reject incomplete UTF-8; incomplete frames are never dispatched.
      throw new LmmError('remote_error', 'Remote stream closed.');
    } finally { clearTimeout(watchdog); }
  } catch (error) {
    if (error instanceof LmmError) throw error;
    throw new LmmError('remote_error', 'Remote stream interrupted or timed out.');
  } finally {
    clearTimeout(timer); clearTimeout(lease);
    combined.removeEventListener('abort', cancel);
    connection.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    if (!reader) await response?.body?.cancel().catch(() => {});
  }
}
