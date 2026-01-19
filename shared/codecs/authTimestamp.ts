import { ICodecStruct } from "../codec.ts";
import { pubKeyBytes, sigBytes, Status } from "../consts.ts";
import type { PublicKey } from "../types.ts";
import { err, ok } from "../valstat.ts";

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
    return Status.Success;
  },
  decode(dec) {
    const [pubKey, status1] = dec.readBytes(pubKeyBytes);
    if (status1 !== Status.Success) return err(status1);
    const [sig, status2] = dec.readBytes(sigBytes);
    if (status2 !== Status.Success) return err(status2);
    const [timestamp, status3] = dec.readDate();
    if (status3 !== Status.Success) return err(status3);
    return ok({ pubKey: pubKey as PublicKey, sig, timestamp });
  },
};
