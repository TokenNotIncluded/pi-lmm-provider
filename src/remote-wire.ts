import { randomBytes, randomUUID } from 'node:crypto';

/** Shared with docs/pi-remote-control-api.md; no model-provider traffic is involved. */
export const REMOTE_PATH = '/api/remote-control/v1/pi/sessions';
export const REMOTE_SCOPE = 'remote:control';
export const REMOTE_MAX_PLAINTEXT = 48 * 1024;
export const REMOTE_KEYS = {
  enter: '\r', escape: '\x1b', up: '\x1b[A', down: '\x1b[B',
  left: '\x1b[D', right: '\x1b[C', tab: '\t', backspace: '\x7f',
  home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~',
  space: ' ', 'ctrl+s': '\x13', 'ctrl+u': '\x15',
} as const;
export type RemoteKey = keyof typeof REMOTE_KEYS;
export type RemoteCiphertext = { nonce: string; ciphertext: string };
export type RemoteEvent = { type: string; id?: string; [key: string]: unknown };
export type RemoteCommand = {
  version: 1; type: 'command'; id: string; issued_at: number;
  action: 'prompt' | 'abort' | 'ui_response' | 'ui_input';
  content?: string; delivery?: 'steer' | 'followUp'; request_id?: string;
  value?: string | boolean | number; cancelled?: boolean; key?: RemoteKey; text?: string;
};

export function remoteId(): string { return randomUUID(); }
/** 128 random bits, not a short numeric PIN vulnerable to offline guessing. */
export function remotePin(): string { return randomBytes(16).toString('base64url'); }
export function remoteRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function remoteAad(sessionId: string, kind: 'metadata' | 'message', identity: string): string {
  return `lmm-pi-remote:v1:${kind}:${sessionId}:${identity}`;
}
export async function deriveRemoteKey(pin: string, sessionId: string): Promise<CryptoKey> {
  if (!pin || pin.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(sessionId)) throw new Error('Invalid remote key input');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 210_000,
    salt: new TextEncoder().encode(`lmm-pi-remote:v1:${sessionId}`) }, material,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptRemote(key: CryptoKey, payload: unknown, aad: string, maxBytes = REMOTE_MAX_PLAINTEXT): Promise<RemoteCiphertext> {
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  if (plain.byteLength > maxBytes) throw new Error('Remote message exceeds the size limit');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: new TextEncoder().encode(aad), tagLength: 128 }, key, plain);
  return { nonce: Buffer.from(nonce).toString('base64url'), ciphertext: Buffer.from(encrypted).toString('base64url') };
}
export async function decryptRemote(key: CryptoKey, payload: unknown, aad: string): Promise<unknown> {
  if (!remoteRecord(payload)) throw new Error('Invalid remote envelope');
  function decode(value: unknown, max: number): Uint8Array<ArrayBuffer> {
    if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid remote encoding');
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Noncanonical remote encoding');
    return new Uint8Array(bytes);
  }
  const nonce = decode(payload.nonce, 16);
  const ciphertext = decode(payload.ciphertext, 90_000);
  if (nonce.byteLength !== 12 || ciphertext.byteLength < 16 || ciphertext.byteLength > 64 * 1024) throw new Error('Invalid remote envelope size');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: new TextEncoder().encode(aad), tagLength: 128 }, key, ciphertext);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
}
/** Reject ambiguous commands before dispatch, including stale/replayed UI answers. */
export function parseRemoteCommand(value: unknown, now = Date.now()): RemoteCommand | undefined {
  if (!remoteRecord(value) || value.version !== 1 || value.type !== 'command' ||
    typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value.id) ||
    typeof value.issued_at !== 'number' || !Number.isSafeInteger(value.issued_at) ||
    Math.abs(now - value.issued_at) > 120_000) return;
  if (value.action === 'abort') return value as RemoteCommand;
  if (value.action === 'prompt' && typeof value.content === 'string' && value.content.trim() &&
    Buffer.byteLength(value.content) <= 32_000 && (value.delivery === undefined || value.delivery === 'steer' || value.delivery === 'followUp')) return value as RemoteCommand;
  if (typeof value.request_id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value.request_id)) return;
  if (value.action === 'ui_response' && (value.cancelled === true || typeof value.value === 'boolean' || (typeof value.value === 'number' && Number.isInteger(value.value) && value.value >= 0 && value.value < 1000) ||
    (typeof value.value === 'string' && Buffer.byteLength(value.value) <= 32_000))) return value as RemoteCommand;
  if (value.action === 'ui_input') {
    if (typeof value.key === 'string' && Object.hasOwn(REMOTE_KEYS, value.key) && value.text === undefined) return value as RemoteCommand;
    if (typeof value.text === 'string' && value.key === undefined && value.text.length > 0 && Buffer.byteLength(value.text) <= 8_000 &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.text)) return value as RemoteCommand;
  }
}
