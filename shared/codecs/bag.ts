import { ICodecStruct } from "../codec.ts";
import { kdmBytes, sigBytes } from "../consts.ts";
import type { IBag } from "../types.ts";

export const bagCodec: ICodecStruct<IBag> = {
  encode(enc, bag) {
    enc.writeBytes(bag.sig);
    enc.writeBytes(bag.kdm);
    enc.writeVarInt(bag.lenHeadCph);
    enc.writeVarInt(bag.lenBodyCph);
    enc.writeBytes(bag.headCph);
    enc.writeBytes(bag.bodyCph);
  },
  decode(dec) {
    const sig = dec.readBytes(sigBytes);
    const kdm = dec.readBytes(kdmBytes);
    const lenHeadCph = dec.readVarInt();
    const lenBodyCph = dec.readVarInt();
    const headCph = dec.readBytes(lenHeadCph);
    const bodyCph = dec.readBytes(lenBodyCph);
    return {
      sig,
      kdm,
      lenHeadCph,
      lenBodyCph,
      headCph,
      bodyCph,
    };
  },
};
