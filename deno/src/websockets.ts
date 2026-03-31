import { validateAuthTimestamp } from "../../shared/auth.ts";
import { btoh } from "../../shared/binary.ts";
import type { IClock } from "../../shared/clock.ts";
import { IAuthTimestamp } from "../../shared/codecs/authTimestamp.ts";
import { Status } from "../../shared/consts.ts";
import type {
  IHostCrypto,
  IPushNotifier,
  IPushOpenResponse,
  PublicKey,
  PushReceiver,
} from "../../shared/types.ts";

class DenoWebsocketNotifier implements IPushNotifier {
  // recvs maps a user's pubKeyHex => the set of listener functions.
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

  async push(pubKey: PublicKey, data: Uint8Array): Promise<void> {
    const pubKeyHex = btoh(pubKey);
    const recvs = this.recvs.get(pubKeyHex);
    if (recvs) {
      for (const r of recvs) {
        r(data);
      }
    }
  }
}

const denoWebsocketNotifier = new DenoWebsocketNotifier();
export default denoWebsocketNotifier;
