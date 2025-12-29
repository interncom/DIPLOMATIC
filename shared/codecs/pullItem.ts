import { ICodecStruct } from "../codec.ts";
import { hashBytes } from "../consts.ts";

export interface IEnvelopePullItem {
  hash: Uint8Array;
  bodyCph: Uint8Array;
}

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

