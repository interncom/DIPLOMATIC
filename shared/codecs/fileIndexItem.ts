// One bag in an export head section: bag kdm, encrypted head, and body length.

import { ICodecStruct } from "../codec.ts";
import { kdmBytes, Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

export interface IFileIndexItem {
  kdm: Uint8Array; // Bag kdm for this message.
  headCph: Uint8Array; // Encrypted encoded message head.
  lenBody: number; // Number of bytes in bodyCph. Zero when there is no body.
}

export const fileIndexItemCodec: ICodecStruct<IFileIndexItem> = {
  encode(enc, item) {
    enc.writeBytes(item.kdm);
    const s1 = enc.writeVarBytes(item.headCph);
    if (s1 !== Status.Success) return s1;
    return enc.writeVarInt(item.lenBody);
  },
  decode(dec) {
    const [kdm, s1] = dec.readBytes(kdmBytes);
    if (s1 !== Status.Success) return err(s1);
    const [headCph, s2] = dec.readVarBytes();
    if (s2 !== Status.Success) return err(s2);
    const [lenBody, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    return ok({ kdm, headCph, lenBody });
  },
};
