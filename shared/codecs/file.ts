// Export file container: signed header, then one chunk per realm.

import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";
import { fileHeadCodec, type IFileHead } from "./fileHead.ts";

export interface IFile {
  head: IFileHead;
  chunks: Uint8Array; // Head section, then bodies, for each realm in order.
}

export const fileCodec: ICodecStruct<IFile> = {
  encode(enc, file) {
    const s1 = enc.writeStruct(fileHeadCodec, file.head);
    if (s1 !== Status.Success) return s1;
    enc.writeBytes(file.chunks);
    return Status.Success;
  },
  decode(dec) {
    const [head, s1] = dec.readStruct(fileHeadCodec);
    if (s1 !== Status.Success) return err(s1);
    return ok({ head, chunks: dec.readRest() });
  },
};
