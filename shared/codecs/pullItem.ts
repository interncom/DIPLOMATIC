import { ICodecStruct } from "../codec.ts";
import { hashBytes } from "../consts.ts";
import { Hash } from "../types.ts";

export interface IBagPullItem {
  hash: Hash;
  bodyCph: Uint8Array;
}

export const pullItemCodec: ICodecStruct<IBagPullItem> = {
  encode(enc, item) {
    enc.writeBytes(item.hash);
    enc.writeVarInt(item.bodyCph.length);
    enc.writeBytes(item.bodyCph);
  },
  decode(dec) {
    const hash = dec.readBytes(hashBytes) as Hash;
    const len = dec.readVarInt();
    const bodyCph = dec.readBytes(len);
    return { hash, bodyCph };
  },
};
