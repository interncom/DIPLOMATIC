import { ICodecStruct } from "../codec.ts";
import { eidBytes, hshBytes, Status } from "../consts.ts";
import { Hash } from "../types.ts";
import { err, ok } from "../valstat.ts";

export interface IFileHead {
  lbl: string; // Key derivation label.
  idx: number; // Key derivation index
  num: number; // Number of bags.
  hsh: Hash; // Hash of INDEX section.
}

export const fileHeadCodec: ICodecStruct<IFileHead> = {
  encode(enc, head) {
    const s1 = enc.writeVarString(head.lbl);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarInt(head.idx);
    if (s2 !== Status.Success) return s2;
    const s3 = enc.writeVarInt(head.num);
    if (s3 !== Status.Success) return s3;
    enc.writeBytes(head.hsh);
    return Status.Success;
  },
  decode(dec) {
    const [lbl, s1] = dec.readVarString();
    if (s1 !== Status.Success) return err(s1);
    const [idx, s2] = dec.readVarInt();
    if (s2 !== Status.Success) return err(s2);
    const [num, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    const [hsh, s4] = dec.readBytes(hshBytes);
    if (s4 !== Status.Success) return err(s4);
    return ok({ lbl, idx, num, hsh: hsh as Hash });
  },
};
