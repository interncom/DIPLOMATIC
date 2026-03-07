import { ICodecStruct } from "../codec.ts";
import { kdmBytes, Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

export interface IFileIndexItem {
  kdm: Uint8Array; // Key derivation material for this message.
  headCph: Uint8Array; // Encrypted encoded message head.
  lenBody: number; // Number of bytes in bodyCph.
  offBody?: number; // Byte offset of bodyCph in BODY section.
}

export const fileIndexItemCodec: ICodecStruct<IFileIndexItem> = {
  encode(enc, item) {
    enc.writeBytes(item.kdm);
    const s1 = enc.writeVarBytes(item.headCph);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarInt(item.lenBody);
    if (s2 !== Status.Success) return s2;
    if (item.lenBody > 0 && item.offBody !== undefined) {
      const s3 = enc.writeVarInt(item.offBody);
      if (s3 !== Status.Success) return s3;
    }
    return Status.Success;
  },
  decode(dec) {
    const [kdm, s0] = dec.readBytes(kdmBytes);
    if (s0 !== Status.Success) return err(s0);
    const [headCph, s1] = dec.readVarBytes();
    if (s1 !== Status.Success) return err(s1);
    const [lenBody, s2] = dec.readVarInt();
    if (s2 !== Status.Success) return err(s2);
    let offBody: number | undefined;
    if (lenBody > 0) {
      const [offset, s4] = dec.readVarInt();
      if (s4 !== Status.Success) return err(s4);
      offBody = offset;
    }
    return ok({ kdm, headCph, lenBody, offBody });
  },
};
