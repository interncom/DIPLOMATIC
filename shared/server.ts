import type {
  IHostCrypto,
  IListDeltasResponse,
  IOperationRequest,
  IRegistrationRequest,
  IStorage,
  IWebsocketNotifier,
} from "./types.ts";
import { btoh, htob, uint8ArraysEqual } from "./lib.ts";
import { concat } from "./lib.ts";
import {
  tsAuthSize,
  envelopeHeaderSize,
  hashSize,
  responseItemSize,
  clockToleranceMs,
} from "./consts.ts";
import { decodeSigProvenData, type ISigProvenData } from "./sigProof.ts";
import {
  encodeEnvelope,
  decodeEnvelope,
  decodeEnvelopeHeader,
  type IEnvelope,
  type IEnvelopeHeader,
} from "./envelope.ts";
import { Decoder, Encoder } from "./codec.ts";

const allowedHeaders = ["X-DIPLOMATIC-KEY", "X-DIPLOMATIC-SIG"];

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

export enum Status {
  Success = 0,
  InvalidSignature = 3,
  ClockOutOfSync = 4,
  UserNotRegistered = 5,
  ServerMisconfigured = 6,
  MissingBody = 7,
  ExtraBodyContent = 8,
  MissingParam = 9,
  InvalidParam = 10,
  InvalidRequest = 11,
  InternalError = 12,
  NotFound = 13,
}

function respFor(status: Status): Response {
  switch (status) {
    case Status.InvalidSignature:
      return new Response("Invalid signature", { status: 401 });
    case Status.ClockOutOfSync:
      return new Response("Clock out of sync", { status: 400 });
    case Status.UserNotRegistered:
      return new Response("Unauthorized", { status: 401 });
    case Status.ServerMisconfigured:
      return new Response("Server misconfigured", { status: 500 });
    case Status.MissingBody:
      return new Response("Missing request body", { status: 400 });
    case Status.ExtraBodyContent:
      return new Response("Extra body content", { status: 400 });
    case Status.MissingParam:
      return new Response("Missing from param", { status: 400 });
    case Status.InvalidParam:
      return new Response("Invalid from param", { status: 400 });
    case Status.InvalidRequest:
      return new Response("Invalid request format", { status: 400 });
    case Status.InternalError:
      return new Response("Internal error", { status: 500 });
    case Status.NotFound:
      return new Response("Not Found", { status: 404 });
    default:
      throw new Error(`Unhandled status: ${status}`);
  }
}

export class DiplomaticServer {
  hostID: string;
  storage: IStorage;
  crypto: IHostCrypto;
  notifier: IWebsocketNotifier;
  constructor(
    hostID: string,
    storage: IStorage,
    crypto: IHostCrypto,
    notifier: IWebsocketNotifier,
  ) {
    this.hostID = hostID;
    this.storage = storage;
    this.crypto = crypto;
    this.notifier = notifier;
  }

  async validateTsAuth(tsAuthBytes: Uint8Array): Promise<[Uint8Array, Status]> {
    const tsAuth: ISigProvenData = decodeSigProvenData(tsAuthBytes);
    const timestampMs = new DataView(tsAuth.data.buffer).getBigUint64(0, false);
    const currentTime = Date.now();
    const diff = Math.abs(currentTime - Number(timestampMs));
    if (diff > clockToleranceMs) {
      return [new Uint8Array(0), Status.ClockOutOfSync];
    }
    if (
      !(await this.crypto.checkSigEd25519(
        tsAuth.sig,
        tsAuth.data,
        tsAuth.pubKey,
      ))
    ) {
      return [new Uint8Array(0), Status.InvalidSignature];
    }
    return [tsAuth.pubKey, Status.Success];
  }

  corsHandler = async (request: Request): Promise<Response> => {
    if (request.headers.get("upgrade") === "websocket") {
      return this.notifier.handler(
        request,
        this.storage.hasUser.bind(this.storage),
      );
    }

    if (request.method === "OPTIONS") {
      // Handle CORS preflight request
      return cors(new Response(null));
    }
    const resp = await this.handler(request);

    console.log(`[${resp.status}] ${request.method} ${request.url}`);

    return cors(resp);
  };

  async processEnvelope(
    env: IEnvelope,
    pubKeyHex: string,
    expectedPubKey: Uint8Array,
    now: Date,
  ): Promise<Status> {
    if (
      !(await this.crypto.checkSigEd25519(
        env.sig,
        env.cipherhead,
        expectedPubKey,
      ))
    ) {
      return Status.InvalidSignature; // Invalid envelope signature
    }
    const envelope = encodeEnvelope(env);
    const hsh = await this.crypto.sha256Hash(
      concat(env.cipherhead, env.cipherbody),
    );
    await this.storage.setOp(pubKeyHex, now, envelope, btoh(hsh));
    await this.notifier.notify(pubKeyHex);
    return Status.Success; // Success
  }

  handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/id") {
      if (!this.hostID) {
        return respFor(Status.ServerMisconfigured);
      }
      return new Response(this.hostID, { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/users") {
      try {
        if (!request.body) {
          return respFor(Status.MissingBody);
        }
        const data = new Uint8Array(await request.arrayBuffer());
        const decoder = new Decoder(data);
        const tsAuthBytes = decoder.readBytes(tsAuthSize);
        if (!decoder.done()) {
          return respFor(Status.ExtraBodyContent);
        }
        const [pubKey, status] = await this.validateTsAuth(tsAuthBytes);
        if (status !== Status.Success) return respFor(status);
        const pubKeyHex = btoh(pubKey);
        // Register the public key
        await this.storage.addUser(pubKeyHex);
        return new Response("", { status: 200 });
      } catch (err) {
        if (err instanceof Error) {
          if (err.message === "Invalid signature") {
            return respFor(Status.InvalidSignature);
          }
          return respFor(Status.InvalidRequest);
        }
        console.error(err);
        return respFor(Status.InternalError);
      }
    }

    if (request.method === "POST" && url.pathname === "/ops") {
      const body = request.body;
      if (!body) {
        return respFor(Status.MissingBody);
      }
      const data = new Uint8Array(await request.arrayBuffer());
      const decoder = new Decoder(data);
      const now = new Date();
      try {
        const tsAuthBytes = decoder.readBytes(tsAuthSize);
        const [pubKey, status] = await this.validateTsAuth(tsAuthBytes);
        if (status !== Status.Success) return respFor(status);
        const pubKeyHex = btoh(pubKey);
        if (!(await this.storage.hasUser(pubKeyHex))) {
          return respFor(Status.UserNotRegistered);
        }

        const encoder = new Encoder();
        while (!decoder.done()) {
          const env = decodeEnvelope(decoder);
          // can we simplify this? hash check seems like it could be better.
          const status = await this.processEnvelope(
            env,
            pubKeyHex,
            pubKey,
            now,
          );
          encoder.writeBytes(new Uint8Array([status]));
          encoder.writeBytes(
            await this.crypto.sha256Hash(
              concat(env.cipherhead, env.cipherbody),
            ),
          );
        }
        return new Response(new Uint8Array(encoder.result()), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      } catch (err) {
        if (err instanceof Error) {
          return respFor(Status.InvalidRequest);
        }
        console.error(err);
        return respFor(Status.InternalError);
      }
    }

    if (request.method === "POST" && url.pathname === "/pull") {
      const body = request.body;
      if (!body) {
        return respFor(Status.MissingBody);
      }
      const data = new Uint8Array(await request.arrayBuffer());
      const decoder = new Decoder(data);
      try {
        const tsAuthBytes = decoder.readBytes(tsAuthSize);
        const [pubKey, status] = await this.validateTsAuth(tsAuthBytes);
        if (status !== Status.Success) return respFor(status);
        const pubKeyHex = btoh(pubKey);
        if (!(await this.storage.hasUser(pubKeyHex))) {
          return respFor(Status.UserNotRegistered);
        }

        const encoder = new Encoder();
        while (!decoder.done()) {
          const hash = decoder.readBytes(hashSize);
          const hashHex = btoh(hash);
          const envelope = await this.storage.getOp(pubKeyHex, hashHex);
          if (envelope) {
            encoder.writeBytes(envelope);
          }
        }
        return new Response(encoder.result().slice(), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      } catch (err) {
        if (err instanceof Error) {
          return respFor(Status.InvalidParam);
        }
        console.error(err);
        return respFor(Status.InternalError);
      }
    }

    if (request.method === "POST" && url.pathname === "/peek") {
      const body = request.body;
      if (!body) {
        return respFor(Status.MissingBody);
      }
      const data = new Uint8Array(await request.arrayBuffer());
      const decoder = new Decoder(data);
      try {
        const tsAuthBytes = decoder.readBytes(tsAuthSize);
        if (!decoder.done()) {
          return respFor(Status.ExtraBodyContent);
        }
        const [pubKey, status] = await this.validateTsAuth(tsAuthBytes);
        if (status !== Status.Success) return respFor(status);
        const pubKeyHex = btoh(pubKey);
        if (!(await this.storage.hasUser(pubKeyHex))) {
          return respFor(Status.UserNotRegistered);
        }
        // Get 'from' param
        const fromParam = url.searchParams.get("from");
        if (!fromParam) {
          return respFor(Status.MissingParam);
        }
        const fromMillis = parseInt(fromParam, 10);
        if (isNaN(fromMillis)) {
          return respFor(Status.InvalidParam);
        }
        const begin = new Date(fromMillis).toISOString();
        const end = new Date().toISOString();
        const userOpsList = await this.storage.listOps(pubKeyHex, begin, end);
        const encoder = new Encoder();
        for (const item of userOpsList) {
          encoder.writeBytes(item.sha256);
          encoder.writeBigInt(BigInt(new Date(item.recordedAt).getTime()));
        }
        return new Response(encoder.result().slice(), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      } catch (err) {
        if (err instanceof Error) {
          return respFor(Status.InvalidRequest);
        }
        console.error(err);
        return respFor(Status.InternalError);
      }
    }

    return respFor(Status.NotFound);
  };
}
