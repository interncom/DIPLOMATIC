import { Encoder, Decoder, ICodecStruct } from "./codec.ts";
import { Status, hashBytes, hashSize } from "./consts.ts";

export interface IEnvelopePeekItem {
  hash: Uint8Array;
  recordedAt: Date;
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

export const envelopePushItemCodec: ICodecStruct<IEnvelopePushItem> = {
  encode(enc, item) {
    enc.writeBytes(new Uint8Array([item.status]));
    enc.writeBytes(item.hash);
  },
  decode(dec) {
    const status = dec.readBytes(1)[0];
    const hash = dec.readBytes(hashSize);
    return { status, hash };
  },
};

export const envelopePeekItemCodec: ICodecStruct<IEnvelopePeekItem> = {
  encode(enc, item) {
    enc.writeBytes(item.hash);
    enc.writeDate(item.recordedAt);
    enc.writeVarInt(item.headCph.length);
    enc.writeBytes(item.headCph);
  },
  decode(dec) {
    const hash = dec.readBytes(hashSize);
    const recordedAt = dec.readDate();
    const headCphLen = dec.readVarInt();
    const headCph = dec.readBytes(headCphLen);
    return { hash, recordedAt, headCph };
  },
};

export const envelopePullItemCodec: ICodecStruct<IEnvelopePullItem> = {
  encode(enc, item) {
    enc.writeBytes(item.hash);
    enc.writeVarInt(item.bodyCph.length);
    enc.writeBytes(item.bodyCph);
  },
  decode(dec) {
    const hash = dec.readBytes(hashBytes);
    const len = dec.readVarInt();
    const bodyCph = dec.readBytes(len);
    return { hash, bodyCph };
  },
};
