import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

export interface IRespHead {
  status: Status;
}

export const respHeadCodec: ICodecStruct<IRespHead> = {
  encode(enc, head) {
    enc.writeBytes(new Uint8Array([head.status]));
    return Status.Success;
  },
  decode(dec) {
    const [bytes, s1] = dec.readBytes(1);
    if (s1 !== Status.Success) return err(s1);
    const status = bytes[0] as Status
    return ok({ status });
  },
};
