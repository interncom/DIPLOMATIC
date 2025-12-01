export function encode_varint(n: number | bigint): Uint8Array {
  if (typeof n !== "bigint") n = BigInt(n);
  const bytes: number[] = [];
  while (n > 0n) {
    const byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) {
      bytes.push(byte | 0x80);
    } else {
      bytes.push(byte);
    }
  }
  if (bytes.length === 0) {
    return new Uint8Array([0]);
  }
  return new Uint8Array(bytes);
}

export function decode_varint(bytes: Uint8Array, offset: number = 0): { value: number | bigint; bytesRead: number } {
  let result = 0n;
  let shift = 0;
  let i = offset;
  while (true) {
    if (i >= bytes.length) {
      throw new Error("Incomplete varint");
    }
    const byte = bytes[i++];
    result |= BigInt(byte & 0x7f) << BigInt(shift);
    if ((byte & 0x80) === 0) {
      return { value: result > 0x1FFFFFFFFFFFFFn ? result : Number(result), bytesRead: i - offset };
    }
    shift += 7;
    if (shift >= 64) {
      throw new Error("Varint too long");
    }
  }
}
