// A connID assignment frame is the ConnID type and then the id varint.

import { ICodecStruct } from "../codec.ts";
import {
  maxConnIDBytes,
  maxNotifTypeBytes,
  NotifType,
  Status,
} from "../consts.ts";
import { err, ok } from "../valstat.ts";

// connIDCodec is the id varint inside an assignment frame.
// initConnID and anything past maxConnIDBytes is rejected.
export const connIDCodec: ICodecStruct<number> = {
  encode(enc, n) {
    if (!Number.isSafeInteger(n) || n < 1) return Status.InvalidParam;
    return enc.writeVarInt(n, maxConnIDBytes);
  },
  decode(dec) {
    const [n, st] = dec.readVarInt(maxConnIDBytes);
    if (st !== Status.Success) return err(st);
    if (n < 1 || !dec.done()) return err(Status.InvalidParam);
    return ok(n);
  },
};

// connIDFrameCodec is the assignment message on the notif socket.
export const connIDFrameCodec: ICodecStruct<number> = {
  encode(enc, n) {
    const stTyp = enc.writeVarInt(NotifType.ConnID, maxNotifTypeBytes);
    if (stTyp !== Status.Success) return stTyp;
    return connIDCodec.encode(enc, n);
  },
  decode(dec) {
    const [typ, stTyp] = dec.readVarInt(maxNotifTypeBytes);
    if (stTyp !== Status.Success) return err(stTyp);
    if (typ !== NotifType.ConnID) return err(Status.InvalidParam);
    return connIDCodec.decode(dec);
  },
};
