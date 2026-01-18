import { ValStat } from "./types.ts";
import { Status } from "./consts.ts";

export function encodeVarInt(n: number | bigint): ValStat<Uint8Array> {
  if (typeof n !== "bigint") n = BigInt(n);
  if (n < 0n) return [undefined, Status.InvalidParam];
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
    return [new Uint8Array([0]), Status.Success];
  }
  return [new Uint8Array(bytes), Status.Success];
}

export function decodeVarInt(
  bytes: Uint8Array,
  offset: number = 0,
): ValStat<{ value: number | bigint; bytesRead: number }> {
  let result = 0n;
  let shift = 0;
  let i = offset;
  while (true) {
    if (i >= bytes.length) {
      return [undefined, Status.InvalidMessage];
    }
    const byte = bytes[i++];
    result |= BigInt(byte & 0x7f) << BigInt(shift);
    if ((byte & 0x80) === 0) {
      return [{
        value: result > 0x1fffffffffffffn ? result : Number(result),
        bytesRead: i - offset,
      }, Status.Success];
    }
    shift += 7;
    if (shift >= 64) {
      return [undefined, Status.InvalidMessage];
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

  readBigInt(): ValStat<bigint> {
    if (this.pos + 8 > this.data.length) {
      return [undefined, Status.MissingBody];
    }
    const value = new DataView(
      this.data.buffer,
      this.data.byteOffset + this.pos,
    ).getBigUint64(0, false);
    this.pos += 8;
    return [value, Status.Success];
  }

  readDate(): ValStat<Date> {
    const [timestampMs, status] = this.readBigInt();
    if (status !== Status.Success) return [undefined, status];
    return [new Date(Number(timestampMs)), Status.Success];
  }

  readVarInt(): ValStat<number> {
    const [res, status] = decodeVarInt(this.data, this.pos);
    if (status !== Status.Success) return [undefined, status];
    this.pos += res.bytesRead;
    const val = res.value;
    return [typeof val === "bigint" ? Number(val) : val, Status.Success];
  }

  readBytes(num: number): ValStat<Uint8Array> {
    if (num < 0) {
      return [undefined, Status.InvalidParam];
    }
    if (this.pos + num > this.data.length) {
      return [undefined, Status.MissingBody];
    }
    const bytes = this.data.slice(this.pos, this.pos + num);
    this.pos += num;
    return [bytes, Status.Success];
  }

  readStruct<T>(codec: ICodecStruct<T>): ValStat<T> {
    return codec.decode(this);
  }

  readStructs<T>(codec: ICodecStruct<T>): ValStat<T[]> {
    const results: T[] = [];
    while (!this.done()) {
      const [val, status] = this.readStruct(codec);
      if (status !== Status.Success) return [undefined, status];
      results.push(val);
    }
    return [results, Status.Success];
  }

  readBytesSeq(len: number): ValStat<Uint8Array[]> {
    const results: Uint8Array[] = [];
    while (!this.done()) {
      const [bytes, status] = this.readBytes(len);
      if (status !== Status.Success) return [undefined, status];
      results.push(bytes);
    }
    return [results, Status.Success];
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

  writeVarInt(n: number): Status {
    const [bytes, status] = encodeVarInt(n);
    if (status !== Status.Success) return status;
    this.parts.push(bytes);
    return Status.Success;
  }

  writeBytes(bytes: Uint8Array): void {
    this.parts.push(bytes);
  }

  writeStruct<T>(codec: ICodecStruct<T>, str: T): Status {
    return codec.encode(this, str);
  }

  writeStructs<T>(codec: ICodecStruct<T>, structs: Iterable<T>): Status {
    for (const struct of structs) {

      const status = this.writeStruct(codec, struct);
      if (status !== Status.Success) return status;
    }
    return Status.Success;
  }

  writeBytesSeq(bytesSeq: Iterable<Uint8Array>): void {
    for (const bytes of bytesSeq) {
      this.writeBytes(bytes);
    }
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

export interface ICodecStruct<T> {
  encode: (enc: Encoder, struct: T) => Status;
  decode: (dec: Decoder) => ValStat<T>;
}
