import { ICodecStruct } from "../codec.ts";
import { hashBytes, Status } from "../consts.ts";
import { Hash } from "../types.ts";
import { err, ok } from "../valstat.ts";

export interface IBagPullItem {
  seq: number;
  bodyCph: Uint8Array;
}

export const pullItemCodec: ICodecStruct<IBagPullItem> = {
  encode(enc, item) {
    enc.writeVarInt(item.seq);
    const s = enc.writeVarBytes(item.bodyCph);
    if (s !== Status.Success) return s;
    return Status.Success;
  },
  decode(dec) {
    const [seq, s1] = dec.readVarInt();
    if (s1 !== Status.Success) return err(s1);
    const [bodyCph, s2] = dec.readVarBytes();
    if (s2 !== Status.Success) return err(s2);
    return ok({ seq, bodyCph });
  },
};
