import { ICodecStruct } from "../codec.ts";
import { hshBytes, Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

export interface IMessageHead {
  eid: Uint8Array;
  clk: Date;
  off: number;
  ctr: number;
  len: number;
  hsh?: Uint8Array;
}

export const messageHeadCodec: ICodecStruct<IMessageHead> = {
  encode(enc, msg) {
    const s0 = enc.writeVarBytes(msg.eid);
    if (s0 !== Status.Success) return s0;
    const statClk = enc.writeDate(msg.clk);
    if (statClk !== Status.Success) return statClk;
    const s1 = enc.writeVarInt(msg.off);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarInt(msg.ctr);
    if (s2 !== Status.Success) return s2;
    const s3 = enc.writeVarInt(msg.len);
    if (s3 !== Status.Success) return s3;
    if (msg.hsh) {
      enc.writeBytes(msg.hsh);
    }
    return Status.Success;
  },
  decode(dec) {
    const [eid, s1] = dec.readVarBytes();
    if (s1 !== Status.Success) return err(s1);
    const [clk, s2] = dec.readDate();
    if (s2 !== Status.Success) return err(s2);
    const [off, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    const [ctr, s4] = dec.readVarInt();
    if (s4 !== Status.Success) return err(s4);
    const [len, s5] = dec.readVarInt();
    if (s5 !== Status.Success) return err(s5);
    let hsh: Uint8Array | undefined;
    if ((len as number) > 0) {
      const [h, s6] = dec.readBytes(hshBytes);
      if (s6 !== Status.Success) return err(s6);
      hsh = h;
    }
    return ok({
      eid,
      clk,
      off,
      ctr,
      len,
      hsh,
    });
  },
};
