import { Decoder, ICodecStruct } from "../codec.ts";
import { hshBytes, Status } from "../consts.ts";
import { eidCodec } from "./eid.ts";
import { EntityID } from "../types.ts";
import { err, ok } from "../valstat.ts";

export interface IMessageHead {
  eid: EntityID;
  off: number;
  ctr: number;
  len: number;
  hsh?: Uint8Array;
}

export const messageHeadCodec: ICodecStruct<IMessageHead> = {
  encode(enc, msg) {
    const s0 = enc.writeVarBytes(msg.eid);
    if (s0 !== Status.Success) return s0;
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

    // Decode the EID just to ensure it has the right structure.
    const decEid = new Decoder(eid as Uint8Array);
    const [, statEid] = eidCodec.decode(decEid);
    if (statEid !== Status.Success) return err(statEid);

    const [off, s2] = dec.readVarInt();
    if (s2 !== Status.Success) return err(s2);
    const [ctr, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    const [len, s4] = dec.readVarInt();
    if (s4 !== Status.Success) return err(s4);
    let hsh: Uint8Array | undefined;
    if ((len as number) > 0) {
      const [h, s5] = dec.readBytes(hshBytes);
      if (s5 !== Status.Success) return err(s5);
      hsh = h;
    }
    return ok({
      eid: eid as EntityID,
      off,
      ctr,
      len,
      hsh,
    });
  },
};

export interface IMinimalMessageHead {
  eid: EntityID;
  off: number;
  ctr: number;
}

export const minimalMessageHeadCodec: ICodecStruct<IMinimalMessageHead> = {
  encode(enc, msg) {
    const s0 = enc.writeVarBytes(msg.eid);
    if (s0 !== Status.Success) return s0;
    const s1 = enc.writeVarInt(msg.off);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarInt(msg.ctr);
    return s2;
  },
  decode(dec) {
    const [eid, s1] = dec.readVarBytes();
    if (s1 !== Status.Success) return err(s1);

    const decEid = new Decoder(eid as Uint8Array);
    const [, statEid] = eidCodec.decode(decEid);
    if (statEid !== Status.Success) return err(statEid);

    const [off, s2] = dec.readVarInt();
    if (s2 !== Status.Success) return err(s2);
    const [ctr, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    return ok({
      eid: eid as EntityID,
      off,
      ctr,
    });
  },
};
