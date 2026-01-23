import { ICodecStruct } from "../codec.ts";
import { hashBytes, Status } from "../consts.ts";
import { Hash } from "../types.ts";
import { err, ok } from "../valstat.ts";

export interface IBagPullItem {
  hash: Hash;
  bodyCph: Uint8Array;
}

export const pullItemCodec: ICodecStruct<IBagPullItem> = {
  encode(enc, item) {
    enc.writeBytes(item.hash);
    const s = enc.writeVarBytes(item.bodyCph);
    if (s !== Status.Success) return s;
    return Status.Success;
  },
  decode(dec) {
    const [hash, s1] = dec.readBytes(hashBytes);
    if (s1 !== Status.Success) return err(s1);
    const [bodyCph, s2] = dec.readVarBytes();
    if (s2 !== Status.Success) return err(s2);
    return ok({ hash: hash as Hash, bodyCph });
  },
};
