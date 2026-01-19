import { ICodecStruct } from "../codec.ts";
import { kdmBytes, sigBytes, Status } from "../consts.ts";
import type { IBag } from "../types.ts";
import { err, ok } from "../valstat.ts";

export const bagCodec: ICodecStruct<IBag> = {
  encode(enc, bag): Status {
    enc.writeBytes(bag.sig);
    enc.writeBytes(bag.kdm);
    const s1 = enc.writeVarInt(bag.lenHeadCph);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarInt(bag.lenBodyCph);
    if (s2 !== Status.Success) return s2;
    enc.writeBytes(bag.headCph);
    enc.writeBytes(bag.bodyCph);
    return Status.Success;
  },
  decode(dec) {
    const [sig, s1] = dec.readBytes(sigBytes);
    if (s1 !== Status.Success) return err(s1);
    const [kdm, s2] = dec.readBytes(kdmBytes);
    if (s2 !== Status.Success) return err(s2);
    const [lenHeadCph, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    const [lenBodyCph, s4] = dec.readVarInt();
    if (s4 !== Status.Success) return err(s4);
    const [headCph, s5] = dec.readBytes(lenHeadCph);
    if (s5 !== Status.Success) return err(s5);
    const [bodyCph, s6] = dec.readBytes(lenBodyCph);
    if (s6 !== Status.Success) return err(s6);
    return ok({
      sig,
      kdm,
      lenHeadCph,
      lenBodyCph,
      headCph,
      bodyCph,
    });
  },
};
