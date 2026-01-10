import { btoh } from "../binary.ts";
import { Encoder } from "../codec.ts";
import { authTimestampCodec, IAuthTimestamp } from "../codecs/authTimestamp.ts";
import { IPushListener, PushReceiver } from "../types.ts";

export class WebsocketListener implements IPushListener {
  private websocket?: WebSocket;
  constructor(private url: URL) { }

  connected(): boolean {
    return this.websocket !== undefined &&
      this.websocket.readyState === WebSocket.OPEN;
  }

  connect(authTS: IAuthTimestamp, recv: PushReceiver) {
    const { url } = this;

    const enc = new Encoder();
    enc.writeStruct(authTimestampCodec, authTS);
    const authTSEnc = enc.result();
    const authTSHex = btoh(authTSEnc);

    url.searchParams.set("t", authTSHex);
    this.websocket = new WebSocket(url);

    this.websocket.onopen = (e) => {
      console.log("CONNECTED");
    };

    this.websocket.onclose = (e) => {
      console.log("DISCONNECTED");
      this.connect(authTS, recv);
    };

    this.websocket.onmessage = (e) => {
      console.log(`RECEIVED: ${e.data}`);
      recv(e.data);
    };

    this.websocket.onerror = (e) => {
      console.log(`ERROR: ${e}`);
    };
  }

  disconnect() {
    this.websocket?.close();
    this.websocket = undefined;
  }
}
