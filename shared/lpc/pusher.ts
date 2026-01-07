import type { IPushNotifier, PublicKey, PushReceiver, IPushOpenResponse } from "../types.ts";
import { btoh } from "../lib.ts";
import { Status } from "../consts.ts";

export class CallbackNotifier implements IPushNotifier {
  private recvs: Map<string, Set<(data: Uint8Array) => void>> = new Map();

  open(pubKey: PublicKey, recv: PushReceiver): Promise<IPushOpenResponse> {
    const pubKeyHex = btoh(pubKey);
    if (!this.recvs.has(pubKeyHex)) {
      this.recvs.set(pubKeyHex, new Set());
    }
    this.recvs.get(pubKeyHex)?.add(recv);
    return Promise.resolve({
      send: (data) => {
        recv(data);
        return Status.Success;
      },
      shut: () => {
        this.recvs.get(pubKeyHex)?.delete(recv);
        return Status.Success;
      },
      status: Status.Success,
    });
  }

  async push(pubKey: PublicKey, data: Uint8Array = new TextEncoder().encode("NEW OP")): Promise<void> {
    const pubKeyHex = btoh(pubKey);
    const recvs = this.recvs.get(pubKeyHex);
    if (recvs) {
      for (const recv of recvs) {
        recv(data);
      }
    }
  }
}
