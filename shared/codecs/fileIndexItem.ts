import { ICodecStruct } from "../codec.ts";
import { eidBytes, hshBytes, Status } from "../consts.ts";
import { Hash } from "../types.ts";
import { err, ok } from "../valstat.ts";

export interface IFileIndexItem {
  lenHead: number; // Number of bytes in headCph.
  headCph: Uint8Array; // Encrypted encoded message head.
  lenBody: number; // Number of bytes in bodyCph.
  offBody: number; // Byte offset of bodyCph in BODY section.
}

export const fileHeadCodec: ICodecStruct<IFileIndexItem> = {
  encode(enc, item) {
    const s1 = enc.writeVarInt(item.lenHead);
    if (s1 !== Status.Success) return s1;
    enc.writeBytes(item.headCph);
    const s2 = enc.writeVarInt(item.lenBody);
    if (s2 !== Status.Success) return s2;
    const s3 = enc.writeVarInt(item.offBody);
    if (s3 !== Status.Success) return s3;
    return Status.Success;
  },
  decode(dec) {
    const [lenHead, s1] = dec.readVarInt();
    if (s1 !== Status.Success) return err(s1);
    const [headCph, s2] = dec.readBytes(lenHead);
    if (s2 !== Status.Success) return err(s2);
    const [lenBody, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    const [offBody, s4] = dec.readVarInt();
    if (s4 !== Status.Success) return err(s4);
    return ok({ lenHead, headCph, lenBody, offBody });
  },
};
