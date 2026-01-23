import { ICodecStruct } from "../codec.ts";
import { kdmBytes, sigBytes, Status } from "../consts.ts";
import { ValStat, ok, err } from "../valstat.ts";

export interface IBagPeekItemHead {
  sig: Uint8Array;
  kdm: Uint8Array;
  headCph: Uint8Array;
}

export const peekItemHeadCodec: ICodecStruct<IBagPeekItemHead> = {
  encode(enc, item): Status {
    enc.writeBytes(item.sig);
    enc.writeBytes(item.kdm);
    const s = enc.writeVarBytes(item.headCph);
    if (s !== Status.Success) return s;
    return Status.Success;
  },
  decode(dec): ValStat<IBagPeekItemHead> {
    const [sig, s1] = dec.readBytes(sigBytes);
    if (s1 !== Status.Success) return err(s1);
    const [kdm, s2] = dec.readBytes(kdmBytes);
    if (s2 !== Status.Success) return err(s2);
    const [headCph, s4] = dec.readVarBytes();
    if (s4 !== Status.Success) return err(s4);
    return ok({ sig, kdm, headCph });
  },
};
