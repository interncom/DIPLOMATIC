import type { ICrypto, KeyPair } from "./types.ts";

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

// TODO: implement keyPath.
// The keyPath should be the truncated hash of the message header.
// This prevents an attacker from reusing a compromised derived key.
// The benefit of the keyPath per message is that with a proper HSM,
// the seed never needs to be directly accessible in memory.
// You just feed the keyPath into the HSM and get the derived key out.
// Then symmetrically encrypt/decrypt using that derived key.
export const keyPathBytes = 8;
export const eidBytes = 16;
export const clkBytes = 8;
export const ctrBytes = 4;
export const lenBytes = 8;

// Returns the full encoded message and also a slice of just the encoded header.
export async function encodeOp(
  op: IMessage,
): Promise<[EncodedMessage, Uint8Array]> {
  const len = op.bod?.length ?? 0;

  const encoded = new Uint8Array(
    eidBytes + clkBytes + ctrBytes + lenBytes + len,
  );

  const view = new DataView(encoded.buffer, encoded.byteOffset);
  encoded.set(op.eid, 0);
  view.setBigUint64(eidBytes, BigInt(op.clk.getTime()), false);
  view.setUint32(eidBytes + clkBytes, op.ctr, false);
  view.setBigUint64(eidBytes + clkBytes + ctrBytes, BigInt(len), false);
  const headerBytes = eidBytes + clkBytes + ctrBytes + lenBytes;
  if (op.bod) {
    encoded.set(op.bod, headerBytes);
  }
  const header = encoded.slice(0, headerBytes);
  return [encoded, header];
}

export async function decodeOp(encoded: EncodedMessage): Promise<IMessage> {
  const view = new DataView(encoded.buffer, encoded.byteOffset);
  const eid = encoded.slice(0, eidBytes);
  const clkTime = view.getBigUint64(eidBytes, false);
  const clk = new Date(Number(clkTime));
  const ctr = view.getUint32(eidBytes + clkBytes, false);
  const len = Number(view.getBigUint64(eidBytes + clkBytes + ctrBytes, false));
  const body = encoded.slice(
    eidBytes + clkBytes + ctrBytes + lenBytes,
    eidBytes + clkBytes + ctrBytes + lenBytes + len,
  );
  return { eid, clk, ctr, len, bod: body };
}

export async function derivationKeyMaterial(
  header: Uint8Array,
  crypto: ICrypto,
): Promise<Uint8Array> {
  const hash = await crypto.blake3(header);
  return hash.slice(0, keyPathBytes);
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const res = new Uint8Array(a.length + b.length);
  res.set(a, 0);
  res.set(b, a.length);
  return res;
}
