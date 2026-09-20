import { setTimeout as sleep } from 'node:timers/promises';

/** Additional attempts, never total attempts. */
export const MAX_MODEL_REQUEST_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_BACKOFF_MS = 8_000;
/** Decline longer server delays rather than retrying before Retry-After. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** RFC 9110: nonnegative whole seconds or an HTTP date, not a JS numeric date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // Accept IMF-fixdate and the two obsolete HTTP-date forms. In particular,
  // Date.parse("-1") and Date.parse("1.5") must not become retry delays.
  const asctime = /^[A-Z][a-z]{2} [A-Z][a-z]{2} (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4}$/.test(text);
  const dated = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)
    || /^[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/.test(text);
  if (!asctime && !dated) return undefined;
  const date = Date.parse(asctime ? `${text} GMT` : text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Undefined means stop: do not shorten a server's requested waiting period. */
export function retryDelay(attempt: number, retryAfterMs?: number): number | undefined {
  if (attempt >= MAX_MODEL_REQUEST_RETRIES) return undefined;
  if (retryAfterMs !== undefined) {
    return retryAfterMs <= MAX_RETRY_AFTER_MS ? retryAfterMs : undefined;
  }
  return Math.min(RETRY_MAX_BACKOFF_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
}

export async function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  // timers/promises also checks a signal that aborted before listener setup.
  signal?.throwIfAborted();
  await sleep(delay, undefined, { signal });
  signal?.throwIfAborted();
}
