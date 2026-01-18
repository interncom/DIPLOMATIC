import { eidBytes } from "./consts.ts";
import type { EntityID, Hash, ICrypto } from "./types.ts";

// Message is also known as the "operation".
// This is the serialized content, plus header data, which determines ordered application.

export type SerializedContent = Uint8Array;

// IMessage is an operation.
export interface IMessageHead {
  eid: EntityID;
  clk: Date;
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
  clk: Date,
  content: SerializedContent,
  crypto: ICrypto,
): Promise<IUpsertMessage> {
  const eid = await crypto.gen128BitRandomID();
  return genUpsert(eid, clk, 0, content);
}

export async function genInsertHead(
  clk: Date,
  content: SerializedContent,
  crypto: ICrypto,
): Promise<IMessageHead> {
  const eid = await crypto.gen128BitRandomID();
  return genUpsertHead(eid, clk, 0, content, crypto);
}
export async function genUpsertHead(
  eid: EntityID,
  clk: Date,
  ctr: number,
  content: SerializedContent,
  crypto: ICrypto,
): Promise<IMessageHead> {
  if (eid.length !== eidBytes) {
    throw new Error("Invalid EID");
  }
  let hsh: Uint8Array | undefined;
  if (content.length > 0) {
    hsh = await crypto.blake3(content);
  }
  return {
    eid,
    clk,
    ctr,
    len: content.length,
    hsh,
  };
}

export function genUpsert(
  eid: EntityID,
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

export function genDelete(
  eid: EntityID,
  clk: Date,
  ctr: number,
): IDeleteMessage {
  return {
    eid,
    clk,
    ctr,
    len: 0,
  };
}

export function genDeleteHead(
  eid: EntityID,
  clk: Date,
  ctr: number,
): IMessageHead {
  return {
    eid,
    clk,
    ctr,
    len: 0,
  };
}
