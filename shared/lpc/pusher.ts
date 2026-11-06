// In-process notifier. Fans a user's notifs out, skipping the client that pushed.

import type {
  IPushNotifier,
  IPushOpenResponse,
  PublicKey,
  PushReceiver,
} from "../types.ts";
import { btoh } from "../binary.ts";
import { encodeStruct } from "../codec.ts";
import { connIDFrameCodec } from "../codecs/connID.ts";
import { notifMsgCodec } from "../codecs/notifMsg.ts";
import { connIDSkip, nextConnID } from "../connID.ts";
import { NotifType, Status } from "../consts.ts";
import { IAuthTimestamp } from "../codecs/authTimestamp.ts";
import { validateAuthTimestamp } from "../auth.ts";
import type { IHostCrypto } from "../types.ts";
import type { IClock } from "../clock.ts";

type Recv = { connID: number; recv: PushReceiver };

export class CallbackNotifier implements IPushNotifier {
  private recvs: Map<string, Recv[]> = new Map();

  async open(
    authTS: IAuthTimestamp,
    recv: PushReceiver,
    crypto: IHostCrypto,
    clock: IClock,
  ): Promise<IPushOpenResponse> {
    // Validate authTS
    const status = await validateAuthTimestamp(authTS, crypto, clock);
    if (status !== Status.Success) {
      return {
        send: () => status,
        shut: () => status,
        status,
      };
    }

    // Register listener.
    const pubKeyHex = btoh(authTS.pubKey);
    let list = this.recvs.get(pubKeyHex);
    if (!list) {
      list = [];
      this.recvs.set(pubKeyHex, list);
    }

    // Assign connID to this connection.
    const [connID, idSt] = nextConnID(list.map((row) => row.connID));
    if (idSt !== Status.Success) {
      if (list.length === 0) this.recvs.delete(pubKeyHex);
      return { send: () => idSt, shut: () => idSt, status: idSt };
    }

    // Transmit that connID assignment back to the client.
    const [frame, fst] = encodeStruct(connIDFrameCodec, connID);
    if (fst !== Status.Success) {
      if (list.length === 0) this.recvs.delete(pubKeyHex);
      return { send: () => fst, shut: () => fst, status: fst };
    }
    const row: Recv = { connID, recv };
    list.push(row);
    recv(frame);

    // Return connection handle.
    return {
      send: (data) => sendNotif(recv, data),
      shut: () => {
        const cur = this.recvs.get(pubKeyHex);
        if (!cur) return Status.Success;

        // Remove this object, so a listener that reuses its connID stays.
        const i = cur.indexOf(row);
        if (i >= 0) cur.splice(i, 1);

        // Forget the user when this was their last listener.
        if (cur.length === 0) this.recvs.delete(pubKeyHex);

        return Status.Success;
      },
      status: Status.Success,
    };
  }

  push(pubKey: PublicKey, data: Uint8Array, connID?: number): void {
    const list = this.recvs.get(btoh(pubKey));
    if (!list) return;
    for (const row of list) {
      const skip = connID !== undefined && connIDSkip(row.connID, connID);
      if (skip) continue;
      sendNotif(row.recv, data);
    }
  }
}

// sendNotif delivers data as a notif message.
function sendNotif(recv: PushReceiver, data: Uint8Array): Status {
  const [frame, st] = encodeStruct(notifMsgCodec, {
    typ: NotifType.Notif,
    body: data,
  });
  if (st !== Status.Success) return st;
  recv(frame);
  return Status.Success;
}
