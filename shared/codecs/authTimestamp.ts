import { ICodecStruct } from "../codec.ts";
import { pubKeyBytes, sigBytes } from "../consts.ts";
import type { PublicKey } from "../types.ts";

export interface IAuthTimestamp {
  pubKey: PublicKey;
  sig: Uint8Array;
  timestamp: Date;
}

export const authTimestampCodec: ICodecStruct<IAuthTimestamp> = {
  encode(enc, item) {
    enc.writeBytes(item.pubKey);
    enc.writeBytes(item.sig);
    enc.writeDate(item.timestamp);
  },
  decode(dec) {
    const pubKey = dec.readBytes(pubKeyBytes) as PublicKey;
    const sig = dec.readBytes(sigBytes);
    const timestamp = dec.readDate();
    return { pubKey, sig, timestamp };
  },
};
