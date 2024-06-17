// Server.

import { port } from "./consts.ts";
import { decodeAsync } from "https://deno.land/x/msgpack@v1.4/mod.ts";
import type { IRegistrationRequest } from "./types.ts";

interface IStoredOp {
  bin: Uint8Array;
  storedAt: string; // ISO timestamp
}

interface IStorage {
  users: unknown;
  ops: IStoredOp[];
}

const storage: IStorage = {
  users: {}, // Map from userID to signing keys.
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
      const regReq = await decodeAsync(request.body) as IRegistrationRequest;
      if (regReq.token === undefined || regReq.pubKey === undefined) {
        return new Response("Invalid request", { status: 400 });
      }
      if (regReq.token !== regToken) {
        return new Response("Unauthorized", { status: 401 });
      }
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
