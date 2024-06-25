import { decodeAsync, encode } from "https://deno.land/x/msgpack@v1.4/mod.ts";
import type { IGetDeltaPathsResponse, IOperationRequest, IRegistrationRequest, IStorage } from "./types.ts";
import { checkSig } from "./auth.ts";
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
  constructor(hostID: string, regToken: string, storage: IStorage) {
    this.hostID = hostID;
    this.regToken = regToken;
    this.storage = storage;
  }

  corsHandler = async (request: Request): Promise<Response> => {
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
        const req = await decodeAsync(request.body) as IRegistrationRequest;
        if (req.token === undefined || req.pubKey === undefined) {
          return new Response("Invalid request", { status: 400 });
        }
        if (req.token !== this.regToken) {
          return new Response("Unauthorized", { status: 401 });
        }
        // TODO: check pubKey length.
        const pubKeyHex = btoh(req.pubKey);
        this.storage.users.add(pubKeyHex);
        return new Response("", { status: 200 });
      } catch {
        return new Response("Processing request", { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/ops") {
      const now = new Date();

      try {
        if (!request.body) {
          return new Response("Invalid request", { status: 400 });
        }
        const req = await decodeAsync(request.body) as IOperationRequest;
        if (req.cipher === undefined) {
          return new Response("Invalid request", { status: 400 });
        }

        // Check user is registered.
        const pubKeyHex = request.headers.get("X-DIPLOMATIC-KEY");
        if (!pubKeyHex) {
          return new Response("Missing pubkey", { status: 401 });
        }
        if (!this.storage.users.has(pubKeyHex)) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Check signature.
        const sigHex = request.headers.get("X-DIPLOMATIC-SIG");
        if (!sigHex) {
          return new Response("Missing signature", { status: 401 });
        }
        const pubKey = htob(pubKeyHex);
        const sig = htob(sigHex);
        const sigValid = checkSig(sig, req.cipher, pubKey);
        if (!sigValid) {
          return new Response("Invalid signature", { status: 401 });
        }

        const path = opPath(now);
        const fullPath = [pubKeyHex, path].join('/');
        this.storage.ops.set(fullPath, req.cipher);

        return new Response(path, { status: 200 });
      } catch {
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
        if (!this.storage.users.has(pubKeyHex)) {
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
        const sigValid = checkSig(sig, path, pubKey);
        if (!sigValid) {
          return new Response("Invalid signature", { status: 401 });
        }

        // Retrieve op.
        const fullPath = [pubKeyHex, path].join('/');
        const cipher = this.storage.ops.get(fullPath);
        if (cipher === undefined) {
          return new Response("Not found", { status: 404 });
        }

        const respPack = encode({ cipher });
        return new Response(respPack, { status: 200 });
      } catch {
        return new Response("Processing request", { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname.startsWith("/ops")) {
      const now = new Date();
      try {
        // Check user is registerd.
        const pubKeyHex = request.headers.get("X-DIPLOMATIC-KEY");
        if (!pubKeyHex) {
          return new Response("Missing pubkey", { status: 401 });
        }
        if (!this.storage.users.has(pubKeyHex)) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Check signature.
        const sigHex = request.headers.get("X-DIPLOMATIC-SIG");
        if (!sigHex) {
          return new Response("Missing signature", { status: 401 });
        }
        const pubKey = htob(pubKeyHex);
        const sig = htob(sigHex);
        const sigValid = checkSig(sig, url.pathname, pubKey);
        if (!sigValid) {
          return new Response("Invalid signature", { status: 401 });
        }

        // Retrieve ops.
        const fetchedAt = now.toISOString();
        const beginComponent = url.pathname.substring("/ops%3Fbegin=".length);
        const begin = decodeURIComponent(beginComponent);
        const userOpPaths: string[] = [];
        for (const [key, _] of this.storage.ops) {
          const [pkh, ts] = key.split('/');
          if (pkh === pubKeyHex && ts >= begin && ts < fetchedAt) {
            userOpPaths.push(ts);
          }
        }

        const resp: IGetDeltaPathsResponse = {
          paths: userOpPaths,
          fetchedAt,
        }
        const respPack = encode(resp);
        return new Response(respPack, { status: 200 });
      } catch {
        return new Response("Processing request", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}
