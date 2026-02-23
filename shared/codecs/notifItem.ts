import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

// IBagNotifItem is the information sent in a websocket notification informing
// a client that a new bag has been uplodaed to the host. For small-enough bags
// the bag body is inlined along with the header.
export interface IBagNotifItem {
  seq: number;
  headCph: Uint8Array;
  bodyCph?: Uint8Array;
}

export const notifItemCodec: ICodecStruct<IBagNotifItem> = {
  encode(enc, item): Status {
    const s1 = enc.writeVarInt(item.seq);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarBytes(item.headCph);
    if (s2 !== Status.Success) return s2;
    const bodyLen = item.bodyCph ? item.bodyCph.length : 0;
    const s3 = enc.writeVarInt(bodyLen);
    if (s3 !== Status.Success) return s3;
    if (bodyLen > 0) {
      if (!item.bodyCph) return Status.InvalidParam;
      enc.writeBytes(item.bodyCph);
    }
    return Status.Success;
  },
  decode(dec) {
    const [seq, s1] = dec.readVarInt();
    if (s1 !== Status.Success) return err(s1);
    const [headCph, s2] = dec.readVarBytes();
    if (s2 !== Status.Success) return err(s2);
    const [bodyLen, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    let bodyCph: Uint8Array | undefined;
    if (bodyLen > 0) {
      const [body, s4] = dec.readBytes(bodyLen);
      if (s4 !== Status.Success) return err(s4);
      bodyCph = body;
    }
    return ok({ seq, headCph, bodyCph });
  },
};
