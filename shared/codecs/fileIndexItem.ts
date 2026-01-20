import { ICodecStruct } from "../codec.ts";
import { kdmBytes, Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

export interface IFileIndexItem {
  kdm: Uint8Array; // Key derivation material for this message.
  lenHead: number; // Number of bytes in headCph.
  headCph: Uint8Array; // Encrypted encoded message head.
  lenBody: number; // Number of bytes in bodyCph.
  offBody?: number; // Byte offset of bodyCph in BODY section.
}

export const fileIndexItemCodec: ICodecStruct<IFileIndexItem> = {
  encode(enc, item) {
    enc.writeBytes(item.kdm);
    const s1 = enc.writeVarInt(item.lenHead);
    if (s1 !== Status.Success) return s1;
    enc.writeBytes(item.headCph);
    const s2 = enc.writeVarInt(item.lenBody);
    if (s2 !== Status.Success) return s2;
    if (item.lenBody > 0 && item.offBody) {
      const s3 = enc.writeVarInt(item.offBody);
      if (s3 !== Status.Success) return s3;
    }
    return Status.Success;
  },
  decode(dec) {
    const [kdm, s0] = dec.readBytes(kdmBytes);
    if (s0 !== Status.Success) return err(s0);
    const [lenHead, s1] = dec.readVarInt();
    if (s1 !== Status.Success) return err(s1);
    const [headCph, s2] = dec.readBytes(lenHead);
    if (s2 !== Status.Success) return err(s2);
    const [lenBody, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    let offBody: number | undefined;
    if (lenBody > 0) {
      const [offset, s4] = dec.readVarInt();
      if (s4 !== Status.Success) return err(s4);
      offBody = offset;
    }
    return ok({ kdm, lenHead, headCph, lenBody, offBody });
  },
};
