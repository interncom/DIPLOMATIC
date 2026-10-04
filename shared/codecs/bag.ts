// Wire: sig (64), rlm (32), kdm (8), headCph, bodyCph.
// sig covers rlm ‖ headCph, so a host cannot swap the realm.

import { ICodecStruct } from "../codec.ts";
import { hashBytes, kdmBytes, sigBytes, Status } from "../consts.ts";
import { asHostRlm } from "../crypto/derivation.ts";
import type { IBag } from "../types.ts";
import { err, ok } from "../valstat.ts";

export const bagCodec: ICodecStruct<IBag> = {
  encode(enc, bag): Status {
    if (bag.rlm.byteLength !== hashBytes) return Status.InvalidParam;
    if (bag.sig.byteLength !== sigBytes) return Status.InvalidParam;
    enc.writeBytes(bag.sig);
    enc.writeBytes(bag.rlm);
    enc.writeBytes(bag.kdm);
    const s1 = enc.writeVarBytes(bag.headCph);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarBytes(bag.bodyCph);
    if (s2 !== Status.Success) return s2;
    return Status.Success;
  },
  decode(dec) {
    const [sig, s0] = dec.readBytes(sigBytes);
    if (s0 !== Status.Success) return err(s0);
    const [raw, s1] = dec.readBytes(hashBytes);
    if (s1 !== Status.Success) return err(s1);
    const [rlm, bst] = asHostRlm(raw);
    if (bst !== Status.Success) return err(bst);
    const [kdm, s2] = dec.readBytes(kdmBytes);
    if (s2 !== Status.Success) return err(s2);
    const [headCph, s3] = dec.readVarBytes();
    if (s3 !== Status.Success) return err(s3);
    const [bodyCph, s4] = dec.readVarBytes();
    if (s4 !== Status.Success) return err(s4);
    return ok({
      rlm,
      sig,
      kdm,
      headCph,
      bodyCph,
    });
  },
};
