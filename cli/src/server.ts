// Server.

import { port } from "./consts.ts";
import { decodeAsync } from "https://deno.land/x/msgpack@v1.4/mod.ts";
import type { IOperationRequest, IRegistrationRequest } from "./types.ts";
import { checkSig } from "./auth.ts";
import { btoh, htob } from "./lib.ts";

interface IStoredOp {
  bin: Uint8Array;
  storedAt: string; // ISO timestamp
}

interface IStorage {
  users: Set<string>;
  ops: IStoredOp[];
}

const storage: IStorage = {
  users: new Set<string>(), // Set of user pubkeys in hex.
  ops: [],
}

const hostID = Deno.env.get("DIPLOMATIC_ID");
const regToken = Deno.env.get("DIPLOMATIC_REG_TOKEN");
if (!hostID) {
  throw "Missing DIPLOMATIC_ID env var"
}
if (!regToken) {
  throw "Missing DIPLOMATIC_REG_TOKEN env var"
}

const handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/id") {
    if (!hostID) {
      return new Response("Server misconfigured", { status: 500 });
    }
    return new Response(hostID, { status: 200 });
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
      if (req.token !== regToken) {
        return new Response("Unauthorized", { status: 401 });
      }
      // TODO: check pubKey length.
      const pubKeyHex = btoh(req.pubKey);
      storage.users.add(pubKeyHex);
      return new Response(null, { status: 200 });
    } catch {
      return new Response("Processing request", { status: 500 });
    }
  }

  if (request.method === "POST" && url.pathname === "/ops") {
    try {
      if (!request.body) {
        return new Response("Invalid request", { status: 400 });
      }
      const req = await decodeAsync(request.body) as IOperationRequest;
      if (req.cipher === undefined) {
        return new Response("Invalid request", { status: 400 });
      }

      // Check user is registerd.
      const pubKeyHex = request.headers.get("X-DIPLOMATIC-KEY");
      if (!pubKeyHex) {
        return new Response("Missing pubkey", { status: 401 });
      }
      if (!storage.users.has(pubKeyHex)) {
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
        throw "Invalid signature";
      }

      // TODO: Store encrypted op.

      return new Response(null, { status: 200 });
    } catch {
      return new Response("Processing request", { status: 500 });
    }
  }

  // if (request.method === "POST" && url.pathname === "/sync") {
  //   try {
  //     if (!request.body) {
  //       return new Response("Invalid request", { status: 400 });
  //     }
  //     // TODO: check request type.
  //     const rb = await decodeAsync(request.body) as ISyncRequest;

  //     // Check request body is valid

  //     // Gather ops since device last synced.
  //     const lowBound = rb.begin;
  //     const retOps = storage.ops.filter(op => {
  //       return op.storedAt > lowBound;
  //     });

  //     // Process ops
  //     for (const op of rb.ops) {
  //       const sigValid = true; // check pubKey signed op.
  //       if (!sigValid) {
  //         return new Response("Invalid signature", { status: 401 });
  //       }
  //       const storedOp: IStoredOp = {
  //         bin: op,
  //         storedAt: new Date().toISOString(),
  //       };
  //       storage.ops.push(storedOp);
  //     }

  //     const body = JSON.stringify({ ops: retOps, syncedAt: new Date().toISOString() });
  //     return new Response(body, { status: 200 });
  //   } catch {
  //     return new Response("Processing request", { status: 400 });
  //   }
  // }

  return new Response("Not Found", { status: 404 });
};

console.log("DIPLOMATIC PARCEL SERVICE ACTIVE");
Deno.serve({ port }, handler);
