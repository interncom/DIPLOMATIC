import { decode_varint } from "./varint.ts";

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
}
