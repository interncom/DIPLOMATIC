export function btoh(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

export function htob(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  return a.every((byte, i) => byte === b[i]);
}

// Use native implementation of btob64 where possible.
export let btob64: (bytes: Uint8Array) => string;
// @ts-expect-error
if (typeof Uint8Array.prototype.toBase64 === 'function') {
  // @ts-expect-error
  btob64 = bytes => bytes.toBase64();
} else {
  btob64 = bytes => btoa(String.fromCharCode(...bytes));
}

// Use native implementation of b64tob where possible.
export let b64tob: (b64: string) => Uint8Array;
// @ts-expect-error
if (typeof Uint8Array.fromBase64 === 'function') {
  // @ts-expect-error
  b64tob = b64 => Uint8Array.fromBase64(b64);
} else {
  b64tob = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const res = new Uint8Array(a.length + b.length);
  res.set(a, 0);
  res.set(b, a.length);
  return res;
}

// btob128 encodes bytes to base 128 using 1-byte UTF-8 code points.
export function btob128(bytes: Uint8Array): string {
  const codes: number[] = [];
  let bits = 0;
  let bitCount = 0;

  for (const byte of bytes) {
    bits |= byte << bitCount;
    bitCount += 8;

    while (bitCount >= 7) {
      codes.push(bits & 0x7F);
      bits >>>= 7;
      bitCount -= 7;
    }
  }

  if (bitCount > 0) {
    codes.push(bits & 0x7F);
  }

  // Build string in safe chunks
  const CHUNK = 8192;
  let str = '';
  for (let j = 0; j < codes.length; j += CHUNK) {
    str += String.fromCharCode(...codes.slice(j, j + CHUNK));
  }
  return str;
}

// b128tob decodes a base 128 string to bytes using 1-byte UTF-8 code points.
export function b128tob(str: string): Uint8Array {
  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;

  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c > 127) throw new Error('Invalid base128 character');

    bits |= c << bitCount;
    bitCount += 7;

    while (bitCount >= 8) {
      bytes.push(bits & 0xFF);
      bits >>>= 8;
      bitCount -= 8;
    }
  }

  return new Uint8Array(bytes);
}
