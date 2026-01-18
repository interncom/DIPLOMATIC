import type {
  IPushNotifier,
  IPushOpenResponse,
  PublicKey,
  PushReceiver,
} from "../types.ts";
import { btoh } from "../binary.ts";
import { Status } from "../consts.ts";
import { IAuthTimestamp } from "../codecs/authTimestamp.ts";
import { validateAuthTimestamp } from "../auth.ts";
import type { IHostCrypto } from "../types.ts";
import type { IClock } from "../clock.ts";

export class CallbackNotifier implements IPushNotifier {
  private recvs: Map<string, Set<(data: Uint8Array) => void>> = new Map();

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
    const pubKeyHex = btoh(authTS.pubKey);
    if (!this.recvs.has(pubKeyHex)) {
      this.recvs.set(pubKeyHex, new Set());
    }
    this.recvs.get(pubKeyHex)?.add(recv);
    return {
      send: (data) => {
        recv(data);
        return Status.Success;
      },
      shut: () => {
        this.recvs.get(pubKeyHex)?.delete(recv);
        return Status.Success;
      },
      status: Status.Success,
    };
  }

  push(
    pubKey: PublicKey,
    data: Uint8Array = new TextEncoder().encode("NEW OP"),
  ): void {
    const pubKeyHex = btoh(pubKey);
    const recvs = this.recvs.get(pubKeyHex);
    if (recvs) {
      for (const recv of recvs) {
        recv(data);
      }
    }
  }
}
