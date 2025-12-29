import { ICodecStruct } from "../codec.ts";
import { kdmBytes, sigBytes } from "../consts.ts";
import type { IEnvelope } from "../types.ts";

export const envelopeCodec: ICodecStruct<IEnvelope> = {
  encode(enc, env) {
    enc.writeBytes(env.sig);
    enc.writeBytes(env.kdm);
    enc.writeVarInt(env.lenHeadCph);
    enc.writeVarInt(env.lenBodyCph);
    enc.writeBytes(env.headCph);
    enc.writeBytes(env.bodyCph);
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
