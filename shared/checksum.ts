// Set checksum over fixed-width hashes (e.g. msg archive head hashes).

import type { Hash, ICrypto } from "./types.ts";

/** Lexicographic compare of raw bytes (unsigned). */
export function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Checksum of a set of hashes.
 *
 * Preimage: blake3( concat( sort_lexicographic(hashes) ) ), each hash as raw
 * bytes. Empty set → blake3(empty). Order of the input iterable is ignored.
 *
 * For equal-length hashes (e.g. 32-byte blake3 digests), concat is unambiguous.
 */
export async function checksumHashes(
  hashes: Iterable<Hash>,
  crypto: ICrypto,
): Promise<Hash> {
  const arr = Array.from(hashes);
  arr.sort(cmpBytes);
  let total = 0;
  for (const h of arr) {
    total += h.length;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const h of arr) {
    buf.set(h, off);
    off += h.length;
  }
  return crypto.blake3(buf);
}
