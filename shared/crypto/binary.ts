// Constant-time byte compare.

// Compares two byte strings without stopping at the first mismatch.
// Length is checked before the loop.
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let d = 0;
  for (let i = 0; i < a.byteLength; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    d |= x ^ y;
  }
  return d === 0;
}
