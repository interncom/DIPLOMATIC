import { btoh } from "../binary.ts";
import { IPushListener, PublicKey, PushReceiver } from "../types.ts";

export class WebsocketListener implements IPushListener {
  private websocket?: WebSocket;
  constructor(private url: URL) { }

  connected(): boolean {
    return this.websocket !== undefined &&
      this.websocket.readyState === WebSocket.OPEN;
  }

  connect(pubKey: PublicKey, recv: PushReceiver) {
    const { url } = this;

    // TODO: new Encoder output to URL params for IAuthTimestamp.
    const keyHex = btoh(pubKey);
    url.searchParams.set("key", keyHex);
    this.websocket = new WebSocket(url);

    this.websocket.onopen = (e) => {
      console.log("CONNECTED");
    };

    this.websocket.onclose = (e) => {
      console.log("DISCONNECTED");
      this.connect(pubKey, recv);
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
