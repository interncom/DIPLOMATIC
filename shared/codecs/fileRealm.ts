// One realm in an export header: its KDM, bag count, and head-section hash.

import { ICodecStruct } from "../codec.ts";
import { hshBytes, Status } from "../consts.ts";
import type { Hash } from "../types.ts";
import { err, ok } from "../valstat.ts";
import { type IKDM, kdmCodec } from "./kdm.ts";

export interface IFileRealm {
  realm: IKDM;
  num: number; // Bags in this realm. At least 1.
  hsh: Hash; // blake3 of this realm's head section.
}

export const fileRealmCodec: ICodecStruct<IFileRealm> = {
  encode(enc, row) {
    if (!Number.isInteger(row.num) || row.num < 1) return Status.InvalidMessage;
    if (row.hsh.byteLength !== hshBytes) return Status.InvalidParam;
    const s0 = kdmCodec.encode(enc, row.realm);
    if (s0 !== Status.Success) return s0;
    const s1 = enc.writeVarInt(row.num);
    if (s1 !== Status.Success) return s1;
    enc.writeBytes(row.hsh);
    return Status.Success;
  },
  decode(dec) {
    const [realm, s0] = kdmCodec.decode(dec);
    if (s0 !== Status.Success) return err(s0);
    const [num, s1] = dec.readVarInt();
    if (s1 !== Status.Success) return err(s1);
    if (!Number.isInteger(num) || num < 1) return err(Status.InvalidMessage);
    const [hsh, s2] = dec.readBytes(hshBytes);
    if (s2 !== Status.Success) return err(s2);
    return ok({ realm, num, hsh: hsh as Hash });
  },
};
