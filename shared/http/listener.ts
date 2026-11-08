import { btoh } from "../binary.ts";
import { encodeStruct } from "../codec.ts";
import { authTimestampCodec, IAuthTimestamp } from "../codecs/authTimestamp.ts";
import { initConnID, Status } from "../consts.ts";
import { takeNotif } from "../sockmsg.ts";
import { IPushListener, PushReceiver } from "../types.ts";

export class WebsocketListener implements IPushListener {
  private websocket?: WebSocket;
  #connID = initConnID;

  constructor(private url: URL) {}

  // connID is the host-assigned id. initConnID until the assignment frame arrives.
  connID(): number {
    return this.#connID;
  }

  connected(): boolean {
    return this.websocket !== undefined &&
      this.websocket.readyState === WebSocket.OPEN;
  }

  async connect(
    authTS: IAuthTimestamp,
    recv: PushReceiver,
    onDisconnect: () => void = () => {},
    onConnect: () => void = () => {},
  ): Promise<Status> {
    const { url } = this;
    this.#drop();
    this.#connID = initConnID;

    const [authTSEnc, st] = encodeStruct(authTimestampCodec, authTS);
    if (st !== Status.Success) return st;
    const authTSHex = btoh(authTSEnc);

    url.searchParams.set("t", authTSHex);
    const socket = new WebSocket(url);
    this.websocket = socket;

    // Set data type to ArrayBuffer (otherwise .onmessage receives Blobs).
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      console.log("CONNECTED");
      onConnect();
    };

    socket.onclose = () => {
      if (this.websocket !== socket) return;
      console.log("DISCONNECTED");
      this.#connID = initConnID;
      this.websocket = undefined;
      onDisconnect();
    };

    socket.onmessage = (e) => {
      if (this.websocket !== socket) return;
      const bytes = new Uint8Array(e.data);
      takeNotif(bytes, recv, (id) => {
        this.#connID = id;
      });
    };

    socket.onerror = (e) => {
      if (this.websocket !== socket) return;
      console.log(`ERROR: ${JSON.stringify(e)}`);
      this.#connID = initConnID;
      this.websocket = undefined;
      onDisconnect();
    };

    return Promise.resolve(Status.Success);
  }

  disconnect() {
    this.#drop();
    this.#connID = initConnID;
  }

  // #drop closes the current socket without clearing a replacement.
  #drop() {
    const socket = this.websocket;
    this.websocket = undefined;
    socket?.close();
  }
}
