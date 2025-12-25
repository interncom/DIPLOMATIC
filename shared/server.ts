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
import { decodeSigProvenData } from "./sigProof.ts";
import {
  encodeEnvelope,
  decodeEnvelope,
  decodeEnvelopeHeader,
  type IEnvelope,
  type IEnvelopeHeader,
} from "./envelope.ts";
import { Decoder, Encoder } from "./codec.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // Allow any origin
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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
    const tsAuth = decodeSigProvenData(tsAuthBytes);
    const timestampMs = new DataView(tsAuth.data.buffer).getBigUint64(0, false);
    const currentTime = Date.now();
    const diff = Math.abs(currentTime - Number(timestampMs));
    if (diff > clockToleranceMs) {
      return [new Uint8Array(0), Status.ClockOutOfSync];
    }
    const sigValid = await this.crypto.checkSigEd25519(
      tsAuth.sig,
      tsAuth.data,
      tsAuth.pubKey,
    );
    if (!sigValid) {
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

  handleHost = async (request: Request): Promise<Response> => {
    if (!this.hostID) {
      return respFor(Status.ServerMisconfigured);
    }
    return new Response(this.hostID, { status: 200 });
  };

  handleUser = async (
    pubKey: Uint8Array,
    decoder: Decoder,
  ): Promise<Response> => {
    if (!decoder.done()) {
      return respFor(Status.ExtraBodyContent);
    }
    try {
      const pubKeyHex = btoh(pubKey);
      // Register the public key
      await this.storage.addUser(pubKeyHex);
      return new Response("", { status: 200 });
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };

  handlePush = async (
    pubKey: Uint8Array,
    decoder: Decoder,
  ): Promise<Response> => {
    const now = new Date();
    try {
      const pubKeyHex = btoh(pubKey);
      const encoder = new Encoder();
      while (!decoder.done()) {
        const env = decodeEnvelope(decoder);
        const hash = await this.crypto.sha256Hash(
          concat(env.cipherhead, env.cipherbody),
        );
        const sigValid = await this.crypto.checkSigEd25519(
          env.sig,
          env.cipherhead,
          pubKey,
        );
        if (sigValid) {
          const envelope = encodeEnvelope(env);
          const hashHex = btoh(hash);
          await this.storage.setOp(pubKeyHex, now, envelope, hashHex);
          await this.notifier.notify(pubKeyHex);
          encoder.writeBytes(new Uint8Array([Status.Success]));
        } else {
          encoder.writeBytes(new Uint8Array([Status.InvalidSignature]));
        }
        encoder.writeBytes(hash);
      }
      return new Response(new Uint8Array(encoder.result()), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };

  handlePull = async (
    pubKey: Uint8Array,
    decoder: Decoder,
  ): Promise<Response> => {
    try {
      const pubKeyHex = btoh(pubKey);
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
      return respFor(Status.InternalError);
    }
  };

  handlePeek = async (
    pubKey: Uint8Array,
    decoder: Decoder,
  ): Promise<Response> => {
    try {
      const fromMillis = decoder.readVarInt();
      if (!decoder.done()) {
        return respFor(Status.ExtraBodyContent);
      }
      const begin = new Date(fromMillis).toISOString();
      const end = new Date().toISOString();

      const pubKeyHex = btoh(pubKey);
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
      return respFor(Status.InternalError);
    }
  };

  handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/id") {
      return this.handleHost(request);
    }

    // Timestamp authentication required beyond this point.
    const body = request.body;
    if (!body) {
      return respFor(Status.MissingBody);
    }
    const data = new Uint8Array(await request.arrayBuffer());
    const decoder = new Decoder(data);
    const tsAuthBytes = decoder.readBytes(tsAuthSize);
    const [pubKey, status] = await this.validateTsAuth(tsAuthBytes);
    if (status !== Status.Success) {
      return respFor(status);
    }

    if (request.method === "POST" && url.pathname === "/users") {
      return this.handleUser(pubKey, decoder);
    }

    // Registered user required beyond this point.
    try {
      const pubKeyHex = btoh(pubKey);
      const userRegistered = await this.storage.hasUser(pubKeyHex);
      if (!userRegistered) {
        return respFor(Status.UserNotRegistered);
      }
    } catch {
      return respFor(Status.InternalError);
    }

    if (request.method === "POST" && url.pathname === "/ops") {
      return this.handlePush(pubKey, decoder);
    }
    if (request.method === "POST" && url.pathname === "/pull") {
      return this.handlePull(pubKey, decoder);
    }
    if (request.method === "POST" && url.pathname === "/peek") {
      return this.handlePeek(pubKey, decoder);
    }

    return respFor(Status.NotFound);
  };
}
