import { Decoder, Encoder } from "./codec.ts";
import { eidCodec } from "./codecs/eid.ts";
import { Status } from "./consts.ts";
import type {
  ICrypto,
  IMessage,
  IMessageHead,
  SerializedContent,
} from "./types.ts";
import { err, ok, ValStat } from "./valstat.ts";

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
): Promise<ValStat<IMessageHead>> {
  const id = await crypto.genRandomBytes(8);
  const encEid = new Encoder();
  const statEid = encEid.writeStruct(eidCodec, { id, ts: now });
  if (statEid !== Status.Success) {
    return err(statEid);
  }
  const eid = encEid.result();

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
): Promise<ValStat<IMessageHead>> {
  const decEid = new Decoder(eid);
  const [eidParsed, statEid] = eidCodec.decode(decEid);
  if (statEid !== Status.Success) {
    return err(statEid);
  }

  const off = now.getTime() - clk.getTime();
  let hsh: Uint8Array | undefined;
  const len = bod?.length ?? 0;
  if (bod && len > 0) {
    hsh = await crypto.blake3(bod);
  }
  return ok({ eid, clk, off, ctr, len, hsh });
}

interface IDeleteParams extends Omit<IMessage, "off" | "len" | "hsh" | "bod"> {
  now: Date;
  crypto: ICrypto;
}

export function genDeleteHead(
  { now, eid, clk, ctr, crypto }: IDeleteParams,
): Promise<ValStat<IMessageHead>> {
  return genUpsertHead({ now, eid, clk, ctr, bod: undefined, crypto });
}

// Test helpers.
export async function genInsert(
  { now, bod, crypto }: IInsertParams,
): Promise<ValStat<IUpsertMessage>> {
  const [head, stat] = await genInsertHead({ now, bod, crypto });
  if (stat !== Status.Success) {
    return err(stat);
  }
  return ok({ ...head, bod });
}

export async function genDelete(
  params: IDeleteParams,
): Promise<ValStat<IDeleteMessage>> {
  const [head, stat] = await genDeleteHead(params);
  if (stat !== Status.Success) {
    return err(stat);
  }
  const { eid, clk, off, ctr } = head;
  return ok({ eid, clk, off, ctr, len: 0 });
}
