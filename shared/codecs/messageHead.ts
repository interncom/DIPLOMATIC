import { ICodecStruct } from "../codec.ts";
import { eidBytes, hshBytes } from "../consts.ts";

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
    enc.writeVarInt(msg.ctr);
    enc.writeVarInt(msg.len);
    if (msg.hsh) {
      enc.writeBytes(msg.hsh);
    }
  },
  decode(dec) {
    const eid = dec.readBytes(eidBytes);
    const clk = dec.readDate();
    const ctr = dec.readVarInt();
    const len = dec.readVarInt();
    let hsh: Uint8Array | undefined;
    if (len > 0) {
      hsh = dec.readBytes(hshBytes);
    }
    return { eid, clk, ctr, len, hsh };
  },
};
