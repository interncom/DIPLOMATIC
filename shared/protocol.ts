import type { IDeltaListItem } from "./types.ts";
import { Encoder, Decoder } from "./codec.ts";
import { Status, hashBytes, hashSize } from "./consts.ts";

export interface IEnvelopePeekItem {
  hash: Uint8Array;
  recordedAt: number;
  headCph: Uint8Array;
}

export interface IEnvelopePullItem {
  hash: Uint8Array;
  bodyCph: Uint8Array;
}

export interface IEnvelopePushItem {
  status: Status;
  hash: Uint8Array;
}

export function encodePeekItem(item: IDeltaListItem, enc: Encoder) {
  enc.writeBytes(item.sha256);
  enc.writeDate(new Date(item.recordedAt));
  enc.writeVarInt(item.headCph.length);
  enc.writeBytes(item.headCph);
}

export function decodePeekItem(dec: Decoder): IEnvelopePeekItem {
  const hash = dec.readBytes(hashSize);
  const recordedAtBigInt = dec.readBigInt();
  const recordedAt = Number(recordedAtBigInt);
  const headCphLen = dec.readVarInt();
  const headCph = dec.readBytes(headCphLen);
  return { hash, recordedAt, headCph };
}

export function encodePullItem(item: IEnvelopePullItem, enc: Encoder) {
  enc.writeBytes(item.hash);
  enc.writeVarInt(item.bodyCph.length);
  enc.writeBytes(item.bodyCph);
}

export function decodePullItem(dec: Decoder): IEnvelopePullItem {
  const hash = dec.readBytes(hashBytes);
  const len = dec.readVarInt();
  const bodyCph = dec.readBytes(len);
  return { hash, bodyCph };
}

export function encodePushItem(item: IEnvelopePushItem, enc: Encoder) {
  enc.writeBytes(new Uint8Array([item.status]));
  enc.writeBytes(item.hash);
}

export function decodePushItem(dec: Decoder): IEnvelopePushItem {
  const status = dec.readBytes(1)[0];
  const hash = dec.readBytes(hashSize);
  return { status, hash };
}
