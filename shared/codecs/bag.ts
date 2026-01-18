import { ICodecStruct } from "../codec.ts";
import { kdmBytes, sigBytes, Status } from "../consts.ts";
import type { IBag } from "../types.ts";

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
    if (s1 !== Status.Success) return [undefined, s1];
    const [kdm, s2] = dec.readBytes(kdmBytes);
    if (s2 !== Status.Success) return [undefined, s2];
    const [lenHeadCph, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return [undefined, s3];
    const [lenBodyCph, s4] = dec.readVarInt();
    if (s4 !== Status.Success) return [undefined, s4];
    const [headCph, s5] = dec.readBytes(lenHeadCph as number);
    if (s5 !== Status.Success) return [undefined, s5];
    const [bodyCph, s6] = dec.readBytes(lenBodyCph as number);
    if (s6 !== Status.Success) return [undefined, s6];
    return [{
      sig: sig as Uint8Array,
      kdm: kdm as Uint8Array,
      lenHeadCph: lenHeadCph as number,
      lenBodyCph: lenBodyCph as number,
      headCph: headCph as Uint8Array,
      bodyCph: bodyCph as Uint8Array,
    }, Status.Success];
  },
};
