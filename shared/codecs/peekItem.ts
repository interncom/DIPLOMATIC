import { ICodecStruct } from "../codec.ts";
import { hashBytes, Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

export interface IBagPeekItem {
  hash: Uint8Array;
  recordedAt: Date;
  headCph: Uint8Array;
}

export const peekItemCodec: ICodecStruct<IBagPeekItem> = {
  encode(enc, item) {
    enc.writeBytes(item.hash);
    enc.writeDate(item.recordedAt);
    const s = enc.writeVarInt(item.headCph.length);
    if (s !== Status.Success) return s;
    enc.writeBytes(item.headCph);
    return Status.Success;
  },
  decode(dec) {
    const [hash, s1] = dec.readBytes(hashBytes);
    if (s1 !== Status.Success) return err(s1);
    const [recordedAt, s2] = dec.readDate();
    if (s2 !== Status.Success) return err(s2);
    const [headCphLen, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    const [headCph, s4] = dec.readBytes(headCphLen);
    if (s4 !== Status.Success) return err(s4);
    return ok({ hash, recordedAt, headCph });
  },
};
