import { encode_varint, decode_varint } from "./varint.ts";

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const res = new Uint8Array(a.length + b.length);
  res.set(a, 0);
  res.set(b, a.length);
  return res;
}

export class Decoder {
  private data: Uint8Array;
  private pos: number = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  readBigInt(): bigint {
    const value = new DataView(
      this.data.buffer,
      this.data.byteOffset + this.pos,
    ).getBigUint64(0, false);
    this.pos += 8;
    return value;
  }

  readVarInt(): number {
    const decode = decode_varint(this.data, this.pos);
    this.pos += decode.bytesRead;
    const val = decode.value;
    return typeof val === "bigint" ? Number(val) : val;
  }

  readBytes(num: number): Uint8Array {
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

  writeVarInt(n: number): void {
    this.parts.push(encode_varint(n));
  }

  writeBytes(bytes: Uint8Array): void {
    this.parts.push(bytes);
  }

  result(): Uint8Array {
    return this.parts.reduce((acc, arr) => concat(acc, arr), new Uint8Array(0));
  }
}
