import { ICodecStruct } from "../codec.ts";
import { kdmBytes, sigBytes } from "../consts.ts";

export interface IBagPeekItemHead {
  sig: Uint8Array;
  kdm: Uint8Array;
  headCph: Uint8Array;
}

export const peekItemHeadCodec: ICodecStruct<IBagPeekItemHead> = {
  encode(enc, item) {
    enc.writeBytes(item.sig);
    enc.writeBytes(item.kdm);
    enc.writeVarInt(item.headCph.length);
    enc.writeBytes(item.headCph);
  },
  decode(dec) {
    const sig = dec.readBytes(sigBytes);
    const kdm = dec.readBytes(kdmBytes);
    const headCphLen = dec.readVarInt();
    const headCph = dec.readBytes(headCphLen);
    return { sig, kdm, headCph };
  },
};
