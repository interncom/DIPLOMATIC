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
    const s2 = enc.writeVarBytes(file.indexEnc);
    if (s2 !== Status.Success) return s2;
    const s3 = enc.writeVarBytes(file.bodyEnc);
    if (s3 !== Status.Success) return s3;
    return Status.Success;
  },
  decode(dec) {
    const [head, s1] = dec.readStruct(fileHeadCodec);
    if (s1 !== Status.Success) return err(s1);
    const [indexEnc, s2] = dec.readVarBytes();
    if (s2 !== Status.Success) return err(s2);
    const [bodyEnc, s3] = dec.readVarBytes();
    if (s3 !== Status.Success) return err(s3);
    return ok({ head, indexEnc, bodyEnc });
  },
};
