import type { IPushNotifier, IProtoHost, PublicKey, PushReceiver, IPushOpenResponse } from "../../shared/types.ts";
import { notifierTSAuthURLParam, Status } from "../../shared/consts.ts";
import { btoh, htob } from "../../shared/binary.ts";
import { authTimestampCodec, IAuthTimestamp } from "../../shared/codecs/authTimestamp.ts";
import { Decoder } from "../../shared/codec.ts";

class DenoWebsocketNotifier implements IPushNotifier {
  private recvs: Map<string, Set<(data: Uint8Array) => void>> = new Map();

  open(authTS: IAuthTimestamp, recv: PushReceiver): IPushOpenResponse {
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

  async push(pubKey: PublicKey, data: Uint8Array = new TextEncoder().encode("NEW OP")): Promise<void> {
    const pubKeyHex = btoh(pubKey);
    const recvs = this.recvs.get(pubKeyHex);
    if (recvs) {
      for (const r of recvs) {
        r(data);
      }
    }
  }

  handle = async (host: IProtoHost, request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const authTSHex = url.searchParams.get(notifierTSAuthURLParam);
    if (!authTSHex) {
      return new Response("Missing authTS", { status: 401 });
    }
    const authTSEnc = htob(authTSHex);
    const dec = new Decoder(authTSEnc);
    const authTS = dec.readStruct(authTimestampCodec);
    if (!await host.storage.hasUser(authTS.pubKey)) {
      return new Response("Unauthorized", { status: 401 });
    }

    console.log("WebSocket connection established");
    const { socket, response } = Deno.upgradeWebSocket(request);

    const chan = this.open(authTS, (data) => socket.send(data));
    // TODO: handle non-success.
    socket.onclose = () => chan.shut();

    return response;
  };
}

const denoWebsocketNotifier = new DenoWebsocketNotifier();
export default denoWebsocketNotifier;
