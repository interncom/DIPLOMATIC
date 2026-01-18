import { ICodecStruct } from "../codec.ts";
import { hashBytes, Status } from "../consts.ts";
import { Hash } from "../types.ts";

export interface IBagPullItem {
  hash: Hash;
  bodyCph: Uint8Array;
}

export const pullItemCodec: ICodecStruct<IBagPullItem> = {
  encode(enc, item) {
    enc.writeBytes(item.hash);
    const s = enc.writeVarInt(item.bodyCph.length);
    if (s !== Status.Success) return s;
    enc.writeBytes(item.bodyCph);
    return Status.Success;
  },
  decode(dec) {
    const [hash, s1] = dec.readBytes(hashBytes);
    if (s1 !== Status.Success) return [undefined, s1];
    const [len, s2] = dec.readVarInt();
    if (s2 !== Status.Success) return [undefined, s2];
    const [bodyCph, s3] = dec.readBytes(len);
    if (s3 !== Status.Success) return [undefined, s3];
    return [{ hash: hash as Hash, bodyCph: bodyCph }, Status.Success];
  },
};
