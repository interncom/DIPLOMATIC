import DiplomaticClient from "./client";
import { btoh } from "./shared/binary";

export class WebsocketManager {
  private websocket?: WebSocket;
  private hostURLForReconnect?: URL;

  constructor(private client: DiplomaticClient) { }

  isConnected(): boolean {
    return this.websocket !== undefined &&
      this.websocket.readyState === WebSocket.OPEN;
  }

  connect(hostURL: URL) {
    if (!this.client.hostKeyPair) {
      return;
    }

    this.hostURLForReconnect = hostURL;
    const url = new URL(hostURL);
    if (window.location.protocol === "https:") {
      url.protocol = "wss";
    } else {
      url.protocol = "ws";
    }

    // TODO: sign something (current timestamp).
    const keyHex = btoh(this.client.hostKeyPair.publicKey);
    url.searchParams.set("key", keyHex);
    this.websocket = new WebSocket(url);

    this.websocket.onopen = (e) => {
      console.log("CONNECTED");
      this.client.emitUpdate();
    };

    this.websocket.onclose = (e) => {
      console.log("DISCONNECTED");
      if (navigator.onLine) {
        this.connect(this.hostURLForReconnect!);
        this.client.emitUpdate();
      }
    };

    this.websocket.onmessage = (e) => {
      console.log(`RECEIVED: ${e.data}`);
      this.client.processOps();
    };

    this.websocket.onerror = (e) => {
      console.log(`ERROR: ${e}`);
    };
  }

  disconnect() {
    this.hostURLForReconnect = undefined;
    this.websocket?.close();
    this.websocket = undefined;
    this.client.emitUpdate();
  }
}
