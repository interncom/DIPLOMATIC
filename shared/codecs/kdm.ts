import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

// KDM stands for Key Derivation Material.
// We use label/index pairs as key derivation material.
// The label is some string that has significance to the user.
// The index (also called "counter") is a number starting at 0.
// Increment the index to rotate keys without changing the label.
// Null KDM (the default) is the empty-string label at index 0.
export interface IKDM {
  label: string;
  index: number;
}

export const kdmCodec: ICodecStruct<IKDM> = {
  encode(enc, kdm) {
    const s1 = enc.writeVarString(kdm.label);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarInt(kdm.index);
    if (s2 !== Status.Success) return s2;
    return Status.Success;
  },
  decode(dec) {
    const [label, s1] = dec.readVarString();
    if (s1 !== Status.Success) return err(s1);
    const [index, s2] = dec.readVarInt();
    if (s2 !== Status.Success) return err(s2);
    return ok({ label, index });
  },
};
