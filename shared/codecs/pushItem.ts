import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

export type IBagPushItem = {
  // idx is the position of the bag in the push request.
  idx: number;

  // status indicates if the host stored the bag.
  status: Status.Success;

  // seq is the ID of the bag in host storage.
  seq: number;
} | {
  idx: number;
  status: Exclude<Status, Status.Success>;
};

export const pushItemCodec: ICodecStruct<IBagPushItem> = {
  encode(enc, item) {
    enc.writeVarInt(item.idx);
    enc.writeBytes(new Uint8Array([item.status]));
    if (item.status === Status.Success) {
      enc.writeVarInt(item.seq);
    }
    return Status.Success;
  },
  decode(dec) {
    const [idx, s0] = dec.readVarInt();
    if (s0 !== Status.Success) return err(s0);
    const [statusBytes, stat1] = dec.readBytes(1);
    if (stat1 !== Status.Success) return err(stat1);
    const status = statusBytes[0];
    if (status !== Status.Success) {
      return ok({ idx, status });
    }
    const [seq, stat2] = dec.readVarInt();
    if (stat2 !== Status.Success) return err(stat2);
    return ok({ idx, status, seq });
  },
};
