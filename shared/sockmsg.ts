// Notif socket messages. Each one starts with a type varint.

import { Decoder } from "./codec.ts";
import { notifMsgCodec } from "./codecs/notifMsg.ts";
import { takeConnID } from "./connID.ts";
import { initConnID, NotifType, Status } from "./consts.ts";
import type { PushReceiver } from "./types.ts";

// takeNotif reads one socket message.
// A connID message sets the id. A notif is passed to recv. Other types are ignored.
export function takeNotif(
  bytes: Uint8Array,
  recv: PushReceiver,
  setID: (n: number) => void,
): void {
  const [msg, st] = new Decoder(bytes).readStruct(notifMsgCodec);
  if (st !== Status.Success) return;
  if (msg.typ === NotifType.ConnID) {
    const id = takeConnID(msg.body);
    if (id !== initConnID) setID(id);
    return;
  }
  if (msg.typ === NotifType.Notif) recv(msg.body);
}
