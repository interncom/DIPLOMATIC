import { eidBytes } from "./consts.ts";
import type { EntityID, Hash, ICrypto } from "./types.ts";

// Message is also known as the "operation".
// This is the serialized content, plus header data, which determines ordered application.

export type SerializedContent = Uint8Array;

// IMessage is an operation.
export interface IMessageHead {
  eid: Uint8Array;
  clk: Date;
  off: number;
  ctr: number;
  len: number;
  hsh?: Uint8Array;
}
export interface IMessage extends IMessageHead {
  bod?: SerializedContent;
}
export interface IMessageWithHash extends IMessage {
  headHash: Hash;
}

interface IUpsertMessage extends IMessage {
  bod: SerializedContent;
}

interface IDeleteMessage extends Omit<IMessage, "bod"> {
  len: 0;
}

export type EncodedMessage = Uint8Array;
export type EncryptedMessage = Uint8Array;

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
  content: SerializedContent,
  crypto: ICrypto,
): Promise<IMessageHead> {
  const eidFull = await crypto.gen128BitRandomID();
  const eid = eidFull.slice(0, 8);
  return genUpsertHead(now, eid, now, 0, content, crypto);
}

// NOTE: if using a non-random eid from multiple devices independently,
// set creationClk to 0 to ensure they all point to the same entity.
export async function genUpsertHead(
  now: Date,
  eid: EntityID,
  creationClk: Date,
  ctr: number,
  content: SerializedContent,
  crypto: ICrypto,
): Promise<IMessageHead> {
  const off = now.getTime() - creationClk.getTime();
  let hsh: Uint8Array | undefined;
  if (content.length > 0) {
    hsh = await crypto.blake3(content);
  }
  return {
    eid,
    clk: creationClk,
    off,
    ctr,
    len: content.length,
    hsh,
  };
}

export function genUpsert(
  eid: EntityID,
  clk: Date,
  ctr: number,
  off: number,
  content: SerializedContent,
): IUpsertMessage {
  return {
    eid,
    clk,
    off,
    ctr,
    len: content.length,
    bod: content,
  };
}

export function genDelete(
  eid: EntityID,
  clk: Date,
  ctr: number,
  off: number,
): IDeleteMessage {
  return {
    eid,
    clk,
    off,
    ctr,
    len: 0,
  };
}

export function genDeleteHead(
  eid: EntityID,
  clk: Date,
  ctr: number,
  off: number,
): IMessageHead {
  return {
    eid,
    clk,
    off,
    ctr,
    len: 0,
  };
}
