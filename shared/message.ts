import type {
  ICrypto,
  IMessage,
  IMessageHead,
  SerializedContent,
} from "./types.ts";

interface IUpsertMessage extends IMessage {
  bod: SerializedContent;
}

interface IDeleteMessage extends Omit<IMessage, "bod"> {
  len: 0;
}

export type EncodedMessage = Uint8Array;

// TODO: reorganize these and use to implement corresponding methods on neoclient.
export async function genInsert(
  now: Date,
  content: SerializedContent,
  crypto: ICrypto,
): Promise<IUpsertMessage> {
  const eidFull = await crypto.gen128BitRandomID();
  const eid = eidFull.slice(0, 8);
  return genUpsert(eid, now, 0, 0, content);
}

export async function genInsertHead(
  now: Date,
  bod: SerializedContent,
  crypto: ICrypto,
): Promise<IMessageHead> {
  const eidFull = await crypto.gen128BitRandomID();
  const eid = eidFull.slice(0, 8);
  return genUpsertHead(now, eid, now, 0, bod, crypto);
}

// NOTE: if using a non-random eid from multiple devices independently,
// set clk to 0 to ensure they all point to the same entity.
export async function genUpsertHead(
  now: Date,
  eid: Uint8Array,
  clk: Date,
  ctr: number,
  bod: SerializedContent | undefined,
  crypto: ICrypto,
): Promise<IMessageHead> {
  const off = now.getTime() - clk.getTime();
  let hsh: Uint8Array | undefined;
  const len = bod?.length ?? 0;
  if (bod && len > 0) {
    hsh = await crypto.blake3(bod);
  }
  return { eid, clk, off, ctr, len, hsh };
}

export function genUpsert(
  eid: Uint8Array,
  clk: Date,
  ctr: number,
  off: number,
  bod: SerializedContent,
): IUpsertMessage {
  const len = bod.length;
  return { eid, clk, off, ctr, len, bod };
}

export function genDelete(
  eid: Uint8Array,
  clk: Date,
  ctr: number,
  off: number,
): IDeleteMessage {
  return { eid, clk, off, ctr, len: 0 };
}

export function genDeleteHead(
  now: Date,
  eid: Uint8Array,
  clk: Date,
  ctr: number,
  crypto: ICrypto,
): Promise<IMessageHead> {
  return genUpsertHead(now, eid, clk, ctr, undefined, crypto);
}
