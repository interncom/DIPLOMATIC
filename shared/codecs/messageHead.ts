import { ICodecStruct } from "../codec.ts";
import { eidBytes, hshBytes, Status } from "../consts.ts";

export interface IMessageHead {
  eid: Uint8Array;
  clk: Date;
  ctr: number;
  len: number;
  hsh?: Uint8Array;
}

export const messageHeadCodec: ICodecStruct<IMessageHead> = {
  encode(enc, msg) {
    enc.writeBytes(msg.eid);
    enc.writeDate(msg.clk);
    const s1 = enc.writeVarInt(msg.ctr);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarInt(msg.len);
    if (s2 !== Status.Success) return s2;
    if (msg.hsh) {
      enc.writeBytes(msg.hsh);
    }
    return Status.Success;
  },
  decode(dec) {
    const [eid, s1] = dec.readBytes(eidBytes);
    if (s1 !== Status.Success) return [undefined, s1];
    const [clk, s2] = dec.readDate();
    if (s2 !== Status.Success) return [undefined, s2];
    const [ctr, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return [undefined, s3];
    const [len, s4] = dec.readVarInt();
    if (s4 !== Status.Success) return [undefined, s4];
    let hsh: Uint8Array | undefined;
    if ((len as number) > 0) {
      const [h, s5] = dec.readBytes(hshBytes);
      if (s5 !== Status.Success) return [undefined, s5];
      hsh = h as Uint8Array;
    }
    return [{
      eid,
      clk,
      ctr,
      len,
      hsh,
    }, Status.Success];
  },
};
