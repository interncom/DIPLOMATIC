import { ICodecStruct } from "../codec.ts";
import { hashBytes } from "../consts.ts";

export interface IEnvelopePeekItem {
  hash: Uint8Array;
  recordedAt: Date;
  headCph: Uint8Array;
}

export const envelopePeekItemCodec: ICodecStruct<IEnvelopePeekItem> = {
  encode(enc, item) {
    enc.writeBytes(item.hash);
    enc.writeDate(item.recordedAt);
    enc.writeVarInt(item.headCph.length);
    enc.writeBytes(item.headCph);
  },
  decode(dec) {
    const hash = dec.readBytes(hashBytes);
    const recordedAt = dec.readDate();
    const headCphLen = dec.readVarInt();
    const headCph = dec.readBytes(headCphLen);
    return { hash, recordedAt, headCph };
  },
};
