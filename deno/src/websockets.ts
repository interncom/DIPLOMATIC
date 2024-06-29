import type { IWebsocketNotifier } from "../../shared/types.ts";

class DenoWebsocketNotifier implements IWebsocketNotifier {
  sockets: Map<string, Set<WebSocket>> = new Map(); // pubKeyHex => sockets.

  handler = async (request: Request, hasUser: (pubKeyHex: string) => Promise<boolean>): Promise<Response> => {
    const url = new URL(request.url);
    const pubKeyHex = url.searchParams.get("key");
    if (!pubKeyHex) {
      return new Response("Missing pubkey", { status: 401 });
    }
    if (!await hasUser(pubKeyHex)) {
      return new Response("Unauthorized", { status: 401 });
    }

    console.log("WebSocket connection established");
    const { socket, response } = Deno.upgradeWebSocket(request);
    if (!this.sockets.has(pubKeyHex)) {
      this.sockets.set(pubKeyHex, new Set());
    }

    socket.onopen = () => {
      console.log("CONNECTED");
      this.sockets.get(pubKeyHex)?.add(socket);
    };
    socket.onmessage = (event) => {
      console.log(`RECEIVED: ${event.data}`);
    };
    socket.onclose = () => {
      console.log("DISCONNECTED")
      this.sockets.get(pubKeyHex)?.delete(socket);
    };
    socket.onerror = (error) => console.error("ERROR:", error);

    return response;
  }

  notify = async (pubKeyHex: string) => {
    const listeners = this.sockets.get(pubKeyHex);
    if (listeners) {
      for (const socket of listeners) {
        socket.send("NEW OP");
      }
    }
  };
}

const denoWebsocketNotifer = new DenoWebsocketNotifier();
export default denoWebsocketNotifer;
