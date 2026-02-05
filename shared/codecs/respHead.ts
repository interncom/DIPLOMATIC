import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";
import { usageQuotaCodec } from "./usageQuota.ts";
import { ISubscriptionMetadata } from "../types.ts";

export interface IRespHead {
  // Overall status of the request.
  status: Status;

  // NTP-style timestamps for client to compute offset from host clock.
  timeRcvd: Date;
  timeSent: Date;

  subscription: ISubscriptionMetadata;
}

export const respHeadCodec: ICodecStruct<IRespHead> = {
  encode(enc, head) {
    enc.writeBytes(new Uint8Array([head.status]));
    const statRcvd = enc.writeDate(head.timeRcvd);
    if (statRcvd !== Status.Success) return statRcvd;
    const statSent = enc.writeDate(head.timeSent);
    if (statSent !== Status.Success) return statSent;

    const statTerm = enc.writeVarInt(head.subscription.term);
    if (statTerm !== Status.Success) return statTerm;
    const statElapsed = enc.writeVarInt(head.subscription.elapsed);
    if (statElapsed !== Status.Success) return statElapsed;
    const statUStat = enc.writeStruct(usageQuotaCodec, head.subscription.stat);
    if (statUStat !== Status.Success) return statUStat;
    const statUDyn = enc.writeStruct(usageQuotaCodec, head.subscription.dyn);
    if (statUDyn !== Status.Success) return statUDyn;

    return Status.Success;
  },
  decode(dec) {
    const [bytes, s1] = dec.readBytes(1);
    if (s1 !== Status.Success) return err(s1);
    const status = bytes[0] as Status;
    const [timeRcvd, s2] = dec.readDate();
    if (s2 !== Status.Success) return err(s2);
    const [timeSent, s3] = dec.readDate();
    if (s3 !== Status.Success) return err(s3);
    const [term, s4] = dec.readVarInt();
    if (s4 !== Status.Success) return err(s4);
    const [elapsed, s5] = dec.readVarInt();
    if (s5 !== Status.Success) return err(s5);
    const [stat, s6] = dec.readStruct(usageQuotaCodec);
    if (s6 !== Status.Success) return err(s6);
    const [dyn, s7] = dec.readStruct(usageQuotaCodec);
    if (s7 !== Status.Success) return err(s7);
    const subscription = { term, elapsed, stat, dyn };
    return ok({ status, timeRcvd, timeSent, subscription });
  },
};
