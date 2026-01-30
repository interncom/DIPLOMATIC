import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

export interface IRespHead {
  // Overall status of the request.
  status: Status;

  // NTP-style timestamps for client to compute offset from host clock.
  timeRcvd: Date;
  timeSent: Date;
}

export const respHeadCodec: ICodecStruct<IRespHead> = {
  encode(enc, head) {
    enc.writeBytes(new Uint8Array([head.status]));
    enc.writeDate(head.timeRcvd);
    enc.writeDate(head.timeSent);
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
    return ok({ status, timeRcvd, timeSent });
  },
};
