// Cryptographic entropy: single source for all random-byte generation.
// Uses the platform Web Crypto CSPRNG (`crypto.getRandomValues`).

/**
 * Fill and return `n` cryptographically secure random bytes.
 */
export function randomBytes(n: number): Uint8Array {
  if (n < 0 || !Number.isFinite(n)) {
    throw new RangeError(`randomBytes: invalid length ${n}`);
  }
  const out = new Uint8Array(n);
  if (n > 0) crypto.getRandomValues(out);
  return out;
}

/**
 * Same as {@link randomBytes}, typed as `Uint8Array<ArrayBuffer>` for DOM
 * `BufferSource` APIs (e.g. WebAuthn challenges and user ids).
 */
export function randomBytesArrayBuffer(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  if (n > 0) crypto.getRandomValues(out);
  return out;
}

/** 32 cryptographically secure random bytes (e.g. master seed material). */
export function random256BitSeed(): Uint8Array {
  return randomBytes(32);
}
