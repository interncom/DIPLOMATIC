import type { IHostCrypto, IGetDeltaPathsResponse, IMsgpackCodec, IOperationRequest, IRegistrationRequest, IStorage } from "./types.ts";
import { btoh, htob } from "./lib.ts";

function opPath(storedAt: Date): string {
  return storedAt.toISOString();
}

const allowedHeaders = [
  "X-DIPLOMATIC-KEY",
  "X-DIPLOMATIC-SIG",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // Allow any origin
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": allowedHeaders.join(","),
};

function cors(resp: Response): Response {
  return new Response(resp.body, {
    headers: { ...resp.headers, ...corsHeaders },
    status: resp.status,
    statusText: resp.statusText,
  });
}

export class DiplomaticServer {
  hostID: string;
  regToken: string;
  storage: IStorage;
  codec: IMsgpackCodec;
  crypto: IHostCrypto;
  constructor(hostID: string, regToken: string, storage: IStorage, codec: IMsgpackCodec, crypto: IHostCrypto) {
    this.hostID = hostID;
    this.regToken = regToken;
    this.storage = storage;
    this.codec = codec;
    this.crypto = crypto;
  }

  sockets: Map<string, Set<WebSocket>> = new Map(); // pubKeyHex => sockets.
  websocketHandler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pubKeyHex = url.searchParams.get("key");
    if (!pubKeyHex) {
      return new Response("Missing pubkey", { status: 401 });
    }
    if (!await this.storage.hasUser(pubKeyHex)) {
      return new Response("Unauthorized", { status: 401 });
    }

    console.log("WebSocket connection established");
    const { socket, response } = Deno.upgradeWebSocket(request);
    if (!this.sockets.has(pubKeyHex)) {
      this.sockets.set(pubKeyHex, new Set());
    }

    // NEXT:
    // 1. store reference to this socket on the server,
    // 2. send message down this socket when new op push comes through
    // 3. Refactor so the websocket implementation can be plugged in
    // 4. Support cloudflare durable objects/workers websockets
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

  corsHandler = async (request: Request): Promise<Response> => {
    if (request.headers.get("upgrade") === "websocket") {
      return this.websocketHandler(request);
    }

    if (request.method === "OPTIONS") {
      // Handle CORS preflight request
      return cors(new Response(null));
    }
    const resp = await this.handler(request);

    console.log(`[${resp.status}] ${request.method} ${request.url}`);

    return cors(resp);
  }

  handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/id") {
      if (!this.hostID) {
        return new Response("Server misconfigured", { status: 500 });
      }
      return new Response(this.hostID, { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/users") {
      try {
        if (!request.body) {
          return new Response("Invalid request", { status: 400 });
        }
        const req = await this.codec.decodeAsync(request.body) as IRegistrationRequest;
        if (req.token === undefined || req.pubKey === undefined) {
          return new Response("Invalid request", { status: 400 });
        }
        if (req.token !== this.regToken) {
          return new Response("Unauthorized", { status: 401 });
        }
        // TODO: check pubKey length.
        const pubKeyHex = btoh(req.pubKey);
        await this.storage.addUser(pubKeyHex);
        return new Response("", { status: 200 });
      } catch (err) {
        console.error(err);
        return new Response("Processing request", { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/ops") {
      const now = new Date();

      try {
        if (!request.body) {
          return new Response("Invalid request", { status: 400 });
        }
        const req = await this.codec.decodeAsync(request.body) as IOperationRequest;
        if (req.cipher === undefined) {
          return new Response("Invalid request", { status: 400 });
        }

        // Check user is registered.
        const pubKeyHex = request.headers.get("X-DIPLOMATIC-KEY");
        if (!pubKeyHex) {
          return new Response("Missing pubkey", { status: 401 });
        }
        if (!await this.storage.hasUser(pubKeyHex)) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Check signature.
        const sigHex = request.headers.get("X-DIPLOMATIC-SIG");
        if (!sigHex) {
          return new Response("Missing signature", { status: 401 });
        }
        const pubKey = htob(pubKeyHex);
        const sig = htob(sigHex);
        const sigValid = await this.crypto.checkSigEd25519(sig, req.cipher, pubKey);
        if (!sigValid) {
          return new Response("Invalid signature", { status: 401 });
        }

        const path = opPath(now);
        await this.storage.setOp(pubKeyHex, path, req.cipher);

        // Notify listeners.
        const listeners = this.sockets.get(pubKeyHex);
        if (listeners) {
          for (const socket of listeners) {
            socket.send("NEW OP");
          }
        }

        return new Response(path, { status: 200 });
      } catch (err) {
        console.error(err);
        return new Response("Processing request", { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname.startsWith("/ops/")) {
      try {
        // Check user is registered.
        const pubKeyHex = request.headers.get("X-DIPLOMATIC-KEY");
        if (!pubKeyHex) {
          return new Response("Missing pubkey", { status: 401 });
        }
        if (!await this.storage.hasUser(pubKeyHex)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const path = url.pathname.substring("/ops/".length);

        // Check signature.
        const sigHex = request.headers.get("X-DIPLOMATIC-SIG");
        if (!sigHex) {
          return new Response("Missing signature", { status: 401 });
        }
        const pubKey = htob(pubKeyHex);
        const sig = htob(sigHex);
        const sigValid = await this.crypto.checkSigEd25519(sig, path, pubKey);
        if (!sigValid) {
          return new Response("Invalid signature", { status: 401 });
        }

        // Retrieve op.
        const cipher = await this.storage.getOp(pubKeyHex, path);
        if (cipher === undefined) {
          return new Response("Not found", { status: 404 });
        }

        const respPack = this.codec.encode({ cipher });
        return new Response(respPack, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      } catch (err) {
        console.error(err);
        return new Response("Processing request", { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname.startsWith("/ops")) {
      const now = new Date();
      try {
        // Check user is registered.
        const pubKeyHex = request.headers.get("X-DIPLOMATIC-KEY");
        if (!pubKeyHex) {
          return new Response("Missing pubkey", { status: 401 });
        }
        if (!await this.storage.hasUser(pubKeyHex)) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Check signature.
        const sigHex = request.headers.get("X-DIPLOMATIC-SIG");
        if (!sigHex) {
          return new Response("Missing signature", { status: 401 });
        }
        const pubKey = htob(pubKeyHex);
        const sig = htob(sigHex);
        const sigValid = await this.crypto.checkSigEd25519(sig, url.pathname, pubKey);
        if (!sigValid) {
          return new Response("Invalid signature", { status: 401 });
        }

        // Retrieve ops.
        const fetchedAt = now.toISOString();
        const beginComponent = url.pathname.substring("/ops%3Fbegin=".length);
        const begin = decodeURIComponent(beginComponent);
        const userOpPaths = await this.storage.listOps(pubKeyHex, begin, fetchedAt);

        const resp: IGetDeltaPathsResponse = {
          paths: userOpPaths,
          fetchedAt,
        }
        const respPack = this.codec.encode(resp);
        return new Response(respPack, { status: 200 });
      } catch (err) {
        console.error(err);
        return new Response("Processing request", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}
