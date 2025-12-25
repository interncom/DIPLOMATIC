import type { ICrypto, KeyPair } from "./types.ts";
import { encode_varint, decode_varint } from "./varint.ts";

// Message is also known as the "operation".
// This is the serialized content, plus header data, which determines ordered application.

type EID = Uint8Array;
type SerializedContent = Uint8Array;

// IMessage is an operation.
export interface IMessage {
  eid: Uint8Array;
  clk: Date;
  ctr: number;
  len: number;
  bod?: SerializedContent;
  hsh?: Uint8Array;
}

interface IUpsertMessage extends IMessage {
  bod: SerializedContent;
}

interface IDeleteMessage extends Omit<IMessage, "bod"> {
  len: 0;
}

export type EncodedMessage = Uint8Array;
export type EncryptedMessage = Uint8Array;

export async function genInsert(
  clk: Date,
  content: SerializedContent,
  crypto: ICrypto,
): Promise<IUpsertMessage> {
  const eid = await crypto.gen128BitRandomID();
  return genUpsert(eid, clk, 0, content);
}

export function genUpsert(
  eid: EID,
  clk: Date,
  ctr: number,
  content: SerializedContent,
): IUpsertMessage {
  return {
    eid,
    clk,
    ctr,
    len: content.length,
    bod: content,
  };
}

export function genDelete(eid: EID, clk: Date, ctr: number): IDeleteMessage {
  return {
    eid,
    clk,
    ctr,
    len: 0,
  };
}

// The kdm should be random. Wait.
// That allows attacker to reuse a compromised key.
// It needs to be based on data an attacker cannot know.
// It can't be the hash of meaningful data within the ciphertext.
// That would leak private information.
// Therefore, it must be derived from meaningless data.
// In other words, a random nonce.
// The benefit of the key-per-message is that with a proper HSM,
// the seed never needs to be directly accessible in memory.
// You just feed the KDM into the HSM and get the derived key out.
// Then symmetrically encrypt/decrypt using that derived key.
export const kdmBytes = 8;
export const eidBytes = 16;
export const clkBytes = 8;

// Returns the full encoded message and also a slice of just the encoded header.
export async function encodeOp(
  op: IMessage,
  crypto: ICrypto,
): Promise<[EncodedMessage, Uint8Array]> {
  const eidBytes_arr = op.eid;
  const clkBytes_arr = new Uint8Array(8);
  const view = new DataView(clkBytes_arr.buffer);
  view.setBigUint64(0, BigInt(op.clk.getTime()), false);
  const ctrVarint = encode_varint(op.ctr);
  const lenVarint = encode_varint(op.len);

  const headerArrays = [];
  if (op.bod && op.len > 0) {
    const hsh = await crypto.blake3(op.bod);
    headerArrays.push(hsh);
  }
  headerArrays.push(eidBytes_arr, clkBytes_arr, ctrVarint, lenVarint);
  const header = headerArrays.reduce(
    (acc, arr) => concat(acc, arr),
    new Uint8Array(0),
  );
  const body = op.bod || new Uint8Array(0);
  const encoded = concat(header, body);
  return [encoded, header];
}

export async function decodeOp(encoded: EncodedMessage): Promise<IMessage> {
  let offset = 0;
  let hsh: Uint8Array | undefined;
  let tempOffset = 0;
  // Check if has hsh by testing reading with hsh
  if (encoded.length >= 32 + eidBytes + clkBytes) {
    let testOffset = 32 + eidBytes + clkBytes;
    const ctrDecode = decode_varint(encoded, testOffset);
    testOffset += ctrDecode.bytesRead;
    const lenDecode = decode_varint(encoded, testOffset);
    const testLen = Number(lenDecode.value);
    testOffset += lenDecode.bytesRead;
    if (testOffset + testLen === encoded.length) {
      // has hsh
      hsh = encoded.slice(0, 32);
      offset = 32;
    } else {
      offset = 0;
    }
  } else {
    offset = 0;
  }
  const eid = encoded.slice(offset, offset + eidBytes);
  offset += eidBytes;
  const clkTime = new DataView(
    encoded.buffer,
    encoded.byteOffset + offset,
  ).getBigUint64(0, false);
  const clk = new Date(Number(clkTime));
  offset += clkBytes;
  const ctrDecode = decode_varint(encoded, offset);
  const ctr =
    typeof ctrDecode.value === "bigint"
      ? Number(ctrDecode.value)
      : ctrDecode.value;
  offset += ctrDecode.bytesRead;
  const lenDecode = decode_varint(encoded, offset);
  const len =
    typeof lenDecode.value === "bigint"
      ? Number(lenDecode.value)
      : lenDecode.value;
  offset += lenDecode.bytesRead;
  const body = encoded.slice(offset, offset + len);
  return { eid, clk, ctr, len, bod: len > 0 ? body : undefined, hsh };
}

export async function derivationKeyMaterial(
  crypto: ICrypto,
): Promise<Uint8Array> {
  const random = await crypto.gen128BitRandomID();
  return random.slice(0, kdmBytes);
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const res = new Uint8Array(a.length + b.length);
  res.set(a, 0);
  res.set(b, a.length);
  return res;
}
