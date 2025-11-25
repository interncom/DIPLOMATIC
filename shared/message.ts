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
// const keyPathBytes = 8;
export const eidBytes = 16;
export const clkBytes = 8;
export const ctrBytes = 4;
export const lenBytes = 8;

export async function encryptOp(
  op: IMessage,
  crypto: ICrypto,
): Promise<EncryptedMessage> {
  const len = op.bod?.length ?? 0;

  const cipher = new Uint8Array(
    eidBytes + clkBytes + ctrBytes + lenBytes + len,
  );

  const view = new DataView(cipher.buffer, cipher.byteOffset);
  cipher.set(op.eid, 0);
  view.setBigUint64(eidBytes, BigInt(op.clk.getTime()), false);
  view.setUint32(eidBytes + clkBytes, op.ctr, false);
  view.setBigUint64(eidBytes + clkBytes + ctrBytes, BigInt(len), false);
  if (op.bod) {
    cipher.set(op.bod, eidBytes + clkBytes + ctrBytes + lenBytes);
  }
  return cipher;
}

export async function decryptOp(
  cipherOp: EncryptedMessage,
  crypto: ICrypto,
): Promise<IMessage> {
  const view = new DataView(cipherOp.buffer, cipherOp.byteOffset);
  const eid = cipherOp.slice(0, eidBytes);
  const clkTime = view.getBigUint64(eidBytes, false);
  const clk = new Date(Number(clkTime));
  const ctr = view.getUint32(eidBytes + clkBytes, false);
  const len = Number(view.getBigUint64(eidBytes + clkBytes + ctrBytes, false));
  const body = cipherOp.slice(
    eidBytes + clkBytes + ctrBytes + lenBytes,
    eidBytes + clkBytes + ctrBytes + lenBytes + len,
  );
  return { eid, clk, ctr, len, bod: body };
}
