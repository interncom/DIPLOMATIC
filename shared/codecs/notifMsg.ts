// A notif socket message is a type varint followed by its body.

import { ICodecStruct } from "../codec.ts";
import { maxNotifTypeBytes, Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

// INotifMsg is one message on the notif socket.
export interface INotifMsg {
  typ: number;
  body: Uint8Array;
}

export const notifMsgCodec: ICodecStruct<INotifMsg> = {
  encode(enc, msg) {
    const st = enc.writeVarInt(msg.typ, maxNotifTypeBytes);
    if (st !== Status.Success) return st;
    enc.writeBytes(msg.body);
    return Status.Success;
  },
  decode(dec) {
    const [typ, st] = dec.readVarInt(maxNotifTypeBytes);
    if (st !== Status.Success) return err(st);
    return ok({ typ, body: dec.readRest() });
  },
};
