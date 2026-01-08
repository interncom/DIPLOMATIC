import type { IPushNotifier, IProtoHost, PublicKey } from "../../shared/types.ts";
import { Status } from "../../shared/consts.ts";
import { btoh, htob } from "../../shared/binary.ts";

class DenoWebsocketNotifier implements IPushNotifier {
  private recvs: Map<string, Set<(data: Uint8Array) => void>> = new Map();

  open(pubKey: PublicKey, recv: (data: Uint8Array) => void): Promise<{ send: (data: Uint8Array) => Status, shut: () => Status, status: Status }> {
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
      for (const r of recvs) {
        r(data);
      }
    }
  }

  handle = async (host: IProtoHost, request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pubKeyHex = url.searchParams.get("key");
    if (!pubKeyHex) {
      return new Response("Missing pubkey", { status: 401 });
    }
    const pubKey = htob(pubKeyHex) as PublicKey;
    if (!await host.storage.hasUser(pubKey)) {
      return new Response("Unauthorized", { status: 401 });
    }

    console.log("WebSocket connection established");
    const { socket, response } = Deno.upgradeWebSocket(request);

    const chan = await this.open(pubKey, (data) => socket.send(data));
    // TODO: handle non-success.
    socket.onclose = () => chan.shut();

    return response;
  };
}

const denoWebsocketNotifier = new DenoWebsocketNotifier();
export default denoWebsocketNotifier;
