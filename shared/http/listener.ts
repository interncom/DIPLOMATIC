import { btoh } from "../binary.ts";
import { Encoder } from "../codec.ts";
import { authTimestampCodec, IAuthTimestamp } from "../codecs/authTimestamp.ts";
import { Status } from "../consts.ts";
import { IPushListener, PushReceiver } from "../types.ts";

export class WebsocketListener implements IPushListener {
  private websocket?: WebSocket;
  constructor(private url: URL) {}

  connected(): boolean {
    return this.websocket !== undefined &&
      this.websocket.readyState === WebSocket.OPEN;
  }

  async connect(
    authTS: IAuthTimestamp,
    recv: PushReceiver,
    onDisconnect: () => void,
  ): Promise<Status> {
    const { url } = this;

    const enc = new Encoder();
    enc.writeStruct(authTimestampCodec, authTS);
    const authTSEnc = enc.result();
    const authTSHex = btoh(authTSEnc);

    url.searchParams.set("t", authTSHex);
    this.websocket = new WebSocket(url);

    // Set data type to ArrayBuffer (otherwise .onmessage receives Blobs).
    this.websocket.binaryType = "arraybuffer";

    this.websocket.onopen = (e) => {
      console.log("CONNECTED");
    };

    this.websocket.onclose = (e) => {
      console.log("DISCONNECTED");
      onDisconnect();
    };

    this.websocket.onmessage = (e) => {
      const bytes = new Uint8Array(e.data);
      recv(bytes);
    };

    this.websocket.onerror = (e) => {
      console.log(`ERROR: ${e}`);
    };

    return Promise.resolve(Status.Success);
  }

  disconnect() {
    this.websocket?.close();
    this.websocket = undefined;
  }
}
