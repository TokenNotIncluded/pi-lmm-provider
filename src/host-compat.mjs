/** Stable host range shared by native loading and the source-switching installer. */
export const MINIMUM_PI_VERSION = '1.0.4';
export const UNSUPPORTED_PI_HOST = 'LMM_PI_HOST_UNSUPPORTED';

export function requireSupportedPiVersion(version) {
  const match = typeof version === 'string' && version.length <= 128
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
    : null;
  const parts = match ? match.slice(1, 4).map(Number) : [];
  const [major = -1, minor = -1, patch = -1] = parts;
  if (parts.length === 3 && parts.every(Number.isSafeInteger)
    && (major > 1 || (major === 1 && (minor > 0 || (minor === 0 && patch >= 4))))) return;
  throw Object.assign(new Error(`${UNSUPPORTED_PI_HOST}: this provider requires stable Pi ${MINIMUM_PI_VERSION} or newer. Upgrade the Pi executable you use, then restart Pi. No LMM provider was registered.`), {
    code: UNSUPPORTED_PI_HOST,
  });
}
