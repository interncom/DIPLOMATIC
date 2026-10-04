import { ICodecStruct } from "../codec.ts";
import { hashBytes, Status } from "../consts.ts";
import { asHostRlm, type HostRlm } from "../crypto/derivation.ts";
import { err, ok } from "../valstat.ts";

// IBagNotifItem is the information sent in a websocket notification informing
// a client that a new bag has been uplodaed to the host. For small-enough bags
// the bag body is inlined along with the header. rlm selects the realm.
export interface IBagNotifItem {
  seq: number;
  rlm: HostRlm;
  headCph: Uint8Array;
  bodyCph?: Uint8Array;
}

export const notifItemCodec: ICodecStruct<IBagNotifItem> = {
  encode(enc, item): Status {
    const s1 = enc.writeVarInt(item.seq);
    if (s1 !== Status.Success) return s1;
    if (item.rlm.byteLength !== hashBytes) return Status.InvalidParam;
    enc.writeBytes(item.rlm);
    const s2 = enc.writeVarBytes(item.headCph);
    if (s2 !== Status.Success) return s2;
    const bodyLen = item.bodyCph ? item.bodyCph.length : 0;
    const s3 = enc.writeVarInt(bodyLen);
    if (s3 !== Status.Success) return s3;
    if (bodyLen > 0) {
      if (!item.bodyCph) return Status.InvalidParam;
      enc.writeBytes(item.bodyCph);
    }
    return Status.Success;
  },
  decode(dec) {
    const [seq, s1] = dec.readVarInt();
    if (s1 !== Status.Success) return err(s1);
    const [raw, rs] = dec.readBytes(hashBytes);
    if (rs !== Status.Success) return err(rs);
    const [rlm, bst] = asHostRlm(raw);
    if (bst !== Status.Success) return err(bst);
    const [headCph, s2] = dec.readVarBytes();
    if (s2 !== Status.Success) return err(s2);
    const [bodyLen, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    let bodyCph: Uint8Array | undefined;
    if (bodyLen > 0) {
      const [body, s4] = dec.readBytes(bodyLen);
      if (s4 !== Status.Success) return err(s4);
      bodyCph = body;
    }
    return ok({ seq, rlm, headCph, bodyCph });
  },
};
