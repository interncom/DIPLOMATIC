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

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const res = new Uint8Array(a.length + b.length);
  res.set(a, 0);
  res.set(b, a.length);
  return res;
}

// btob128 encodes bytes to base 128 using 1-byte UTF-8 code points.
export function btob128(bytes: Uint8Array): string {
  let result = '';
  let bits = 0;
  let bitCount = 0;

  for (const byte of bytes) {
    bits |= byte << bitCount;
    bitCount += 8;

    while (bitCount >= 7) {
      result += String.fromCharCode(bits & 0x7F);
      bits >>>= 7;
      bitCount -= 7;
    }
  }

  if (bitCount > 0) {
    result += String.fromCharCode(bits & 0x7F);
  }

  return result;
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
