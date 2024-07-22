import type { IHostCrypto, IListDeltasResponse, IMsgpackCodec, IOperationRequest, IRegistrationRequest, IStorage, IWebsocketNotifier } from "./types.ts";
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
  notifier: IWebsocketNotifier;
  constructor(hostID: string, regToken: string, storage: IStorage, codec: IMsgpackCodec, crypto: IHostCrypto, notifier: IWebsocketNotifier) {
    this.hostID = hostID;
    this.regToken = regToken;
    this.storage = storage;
    this.codec = codec;
    this.crypto = crypto;
    this.notifier = notifier;
  }

  corsHandler = async (request: Request): Promise<Response> => {
    if (request.headers.get("upgrade") === "websocket") {
      return this.notifier.handler(request, this.storage.hasUser.bind(this.storage));
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

        await this.storage.setOp(pubKeyHex, now, req.cipher);

        // Notify listeners.
        await this.notifier.notify(pubKeyHex);

        const opHash = await this.crypto.sha256Hash(req.cipher);
        const hex = btoh(opHash);
        return new Response(hex, { status: 200 });
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
        const userOpsList = await this.storage.listOps(pubKeyHex, begin, fetchedAt);

        const resp: IListDeltasResponse = {
          deltas: userOpsList,
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
