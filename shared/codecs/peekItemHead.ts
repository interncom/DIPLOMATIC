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
    const s = enc.writeVarInt(item.headCph.length);
    if (s !== Status.Success) return s;
    enc.writeBytes(item.headCph);
    return Status.Success;
  },
  decode(dec): ValStat<IBagPeekItemHead> {
    const [sig, s1] = dec.readBytes(sigBytes);
    if (s1 !== Status.Success) return err(s1);
    const [kdm, s2] = dec.readBytes(kdmBytes);
    if (s2 !== Status.Success) return err(s2);
    const [headCphLen, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    const [headCph, s4] = dec.readBytes(headCphLen);
    if (s4 !== Status.Success) return err(s4);
    return ok({ sig, kdm, headCph });
  },
};
