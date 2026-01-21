import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";
import { fileHeadCodec, IFileHead } from "./fileHead.ts";

export interface IFile {
  head: IFileHead;
  indexEnc: Uint8Array;
  bodyEnc: Uint8Array;
}

export const fileCodec: ICodecStruct<IFile> = {
  encode(enc, file) {
    const s1 = enc.writeStruct(fileHeadCodec, file.head);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarInt(file.indexEnc.length);
    if (s2 !== Status.Success) return s2;
    enc.writeBytes(file.indexEnc);
    const s3 = enc.writeVarInt(file.bodyEnc.length);
    if (s3 !== Status.Success) return s3;
    enc.writeBytes(file.bodyEnc);
    return Status.Success;
  },
  decode(dec) {
    const [head, s1] = dec.readStruct(fileHeadCodec);
    if (s1 !== Status.Success) return err(s1);
    const [indexLen, s2] = dec.readVarInt();
    if (s2 !== Status.Success) return err(s2);
    const [indexEnc, s3] = dec.readBytes(indexLen);
    if (s3 !== Status.Success) return err(s3);
    const [bodyLen, s4] = dec.readVarInt();
    if (s4 !== Status.Success) return err(s4);
    const [bodyEnc, s5] = dec.readBytes(bodyLen);
    if (s5 !== Status.Success) return err(s5);
    return ok({ head, indexEnc, bodyEnc });
  },
};
