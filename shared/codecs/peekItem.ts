import { ICodecStruct } from "../codec.ts";
import { hashBytes, Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

export interface IBagPeekItem {
  seq: number;
  hash: Uint8Array;
  headCph: Uint8Array;
}

export const peekItemCodec: ICodecStruct<IBagPeekItem> = {
  encode(enc, item) {
    enc.writeBytes(item.hash);
    const s1 = enc.writeVarBytes(item.headCph);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarInt(item.seq);
    if (s2 !== Status.Success) return s2;
    return Status.Success;
  },
  decode(dec) {
    const [hash, s1] = dec.readBytes(hashBytes);
    if (s1 !== Status.Success) return err(s1);
    const [headCph, s2] = dec.readVarBytes();
    if (s2 !== Status.Success) return err(s2);
    const [seq, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    return ok({ hash, headCph, seq });
  },
};
