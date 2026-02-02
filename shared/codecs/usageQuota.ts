import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

export interface IUsageQuota {
  quota: number;
  usage?: number;
}

export const usageQuotaCodec: ICodecStruct<IUsageQuota> = {
  encode(enc, uq) {
    enc.writeVarInt(uq.quota);
    if (uq.quota > 0) {
      if (uq.usage === undefined) {
        return Status.MissingParam;
      }
      enc.writeVarInt(uq.usage);
    }
    return Status.Success;
  },
  decode(dec) {
    const [quota, s1] = dec.readVarInt();
    if (s1 !== Status.Success) return err(s1);
    let usage: number | undefined;
    if (quota > 0) {
      const [u, s2] = dec.readVarInt();
      if (s2 !== Status.Success) return err(s2);
      usage = u;
    }
    return ok({ quota, usage });
  },
};
