import type { Hash, ICrypto } from "./types.ts";

// Message is also known as the "operation".
// This is the serialized content, plus header data, which determines ordered application.

type EID = Uint8Array;
type SerializedContent = Uint8Array;

// IMessage is an operation.
export interface IMessageHead {
  eid: Uint8Array;
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
