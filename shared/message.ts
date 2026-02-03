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

interface IInsertParams {
  now: Date;
  bod: SerializedContent;
  crypto: ICrypto;
}

export async function genInsertHead(
  { now, bod, crypto }: IInsertParams,
): Promise<IMessageHead> {
  const eid = await crypto.genRandomBytes(8);
  return genUpsertHead({ now, eid, clk: now, ctr: 0, bod, crypto });
}

interface IUpsertParams extends Omit<IMessage, "off" | "len" | "hsh"> {
  now: Date;
  crypto: ICrypto;
}

// NOTE: if using a non-random eid from multiple devices independently,
// set clk to 0 to ensure they all point to the same entity.
export async function genUpsertHead(
  { now, eid, clk, ctr, bod, crypto }: IUpsertParams,
): Promise<IMessageHead> {
  const off = now.getTime() - clk.getTime();
  let hsh: Uint8Array | undefined;
  const len = bod?.length ?? 0;
  if (bod && len > 0) {
    hsh = await crypto.blake3(bod);
  }
  return { eid, clk, off, ctr, len, hsh };
}

interface IDeleteParams extends Omit<IMessage, "off" | "len" | "hsh" | "bod"> {
  now: Date;
  crypto: ICrypto;
}

export function genDeleteHead(
  { now, eid, clk, ctr, crypto }: IDeleteParams,
): Promise<IMessageHead> {
  return genUpsertHead({ now, eid, clk, ctr, bod: undefined, crypto });
}

// Test helpers.
export async function genInsert(
  { now, bod, crypto }: IInsertParams,
): Promise<IUpsertMessage> {
  const head = await genInsertHead({ now, bod, crypto });
  return { ...head, bod };
}

export async function genDelete(
  params: IDeleteParams,
): Promise<IDeleteMessage> {
  const { eid, clk, off, ctr } = await genDeleteHead(params);
  return { eid, clk, off, ctr, len: 0 };
}
