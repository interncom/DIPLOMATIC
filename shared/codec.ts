import { concat } from "./lib.ts";

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

export function decode_varint(
  bytes: Uint8Array,
  offset: number = 0,
): { value: number | bigint; bytesRead: number } {
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
      return {
        value: result > 0x1fffffffffffffn ? result : Number(result),
        bytesRead: i - offset,
      };
    }
    shift += 7;
    if (shift >= 64) {
      throw new Error("Varint too long");
    }
  }
}

export class Decoder {
  private data: Uint8Array;
  private pos: number = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  static async fromResponse(resp: Response): Promise<Decoder> {
    const arrayBuffer = await resp.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    return new Decoder(data);
  }

  readBigInt(): bigint {
    if (this.pos + 8 > this.data.length) {
      throw new Error("Not enough data to read BigInt (needs 8 bytes)");
    }
    const value = new DataView(
      this.data.buffer,
      this.data.byteOffset + this.pos,
    ).getBigUint64(0, false);
    this.pos += 8;
    return value;
  }

  readDate(): Date {
    const timestampMs = this.readBigInt();
    return new Date(Number(timestampMs));
  }

  readVarInt(): number {
    if (this.pos >= this.data.length) {
      throw new Error("Not enough data to read VarInt");
    }
    const decode = decode_varint(this.data, this.pos);
    this.pos += decode.bytesRead;
    const val = decode.value;
    return typeof val === "bigint" ? Number(val) : val;
  }

  readBytes(num: number): Uint8Array {
    if (num < 0) {
      throw new Error("Cannot read negative number of bytes");
    }
    if (this.pos + num > this.data.length) {
      throw new Error("Not enough data to read requested bytes");
    }
    const bytes = this.data.slice(this.pos, this.pos + num);
    this.pos += num;
    return bytes;
  }

  done(): boolean {
    return this.pos >= this.data.length;
  }

  consumed(): number {
    return this.pos;
  }
}

export class Encoder {
  private parts: Uint8Array[] = [];

  writeBigInt(b: bigint): void {
    const arr = new Uint8Array(8);
    new DataView(arr.buffer).setBigUint64(0, b, false);
    this.parts.push(arr);
  }

  writeDate(ts: Date): void {
    const timestampMs = ts.getTime();
    this.writeBigInt(BigInt(timestampMs));
  }

  writeVarInt(n: number): void {
    if (n < 0) {
      throw new Error("Cannot write negative VarInt");
    }
    this.parts.push(encode_varint(n));
  }

  writeBytes(bytes: Uint8Array): void {
    this.parts.push(bytes);
  }

  result(): Uint8Array {
    const totalLength = this.parts.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of this.parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }
}
