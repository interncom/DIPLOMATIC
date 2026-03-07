import { ICodecStruct } from "../codec.ts";
import { hshBytes, sigBytes, Status } from "../consts.ts";
import { Hash } from "../types.ts";
import { err, ok } from "../valstat.ts";

export interface IFileHead {
  // TODO: determine if even need to store these or better to just compute a kdm and use that.
  lbl: string; // Key derivation label.
  idx: number; // Key derivation index

  num: number; // Number of bags.
  hsh: Hash; // Hash of INDEX section.
  sig: Uint8Array; // Ed25519 signature of hsh.
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
    enc.writeBytes(head.sig);
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
    const [sig, s5] = dec.readBytes(sigBytes);
    if (s5 !== Status.Success) return err(s5);
    return ok({ lbl, idx, num, hsh: hsh as Hash, sig });
  },
};
