import { ICodecStruct } from "../codec.ts";
import { kdmBytes, sigBytes, Status } from "../consts.ts";
import type { IBag } from "../types.ts";
import { err, ok } from "../valstat.ts";

export const bagCodec: ICodecStruct<IBag> = {
  encode(enc, bag): Status {
    enc.writeBytes(bag.sig);
    enc.writeBytes(bag.kdm);
    const s1 = enc.writeVarBytes(bag.headCph);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarBytes(bag.bodyCph);
    if (s2 !== Status.Success) return s2;
    return Status.Success;
  },
  decode(dec) {
    const [sig, s1] = dec.readBytes(sigBytes);
    if (s1 !== Status.Success) return err(s1);
    const [kdm, s2] = dec.readBytes(kdmBytes);
    if (s2 !== Status.Success) return err(s2);
    const [headCph, s3] = dec.readVarBytes();
    if (s3 !== Status.Success) return err(s3);
    const [bodyCph, s4] = dec.readVarBytes();
    if (s4 !== Status.Success) return err(s4);
    return ok({
      sig,
      kdm,
      headCph,
      bodyCph,
    });
  },
};
