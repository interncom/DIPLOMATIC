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
  sigBytes,
  kdmBytes,
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

function binResp(data: Uint8Array): Response {
  // TODO: fix types so it doesn't need the .slice().
  return new Response(data.slice(), {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
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

  handleUser = async (pubKey: Uint8Array, dec: Decoder): Promise<Response> => {
    if (!dec.done()) {
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

  handlePush = async (pubKey: Uint8Array, dec: Decoder): Promise<Response> => {
    const now = new Date();
    try {
      const pubKeyHex = btoh(pubKey);
      const enc = new Encoder();
      while (!dec.done()) {
        const env = decodeEnvelope(dec);
        const headHash = await this.crypto.sha256Hash(env.cipherhead);
        const sigValid = await this.crypto.checkSigEd25519(
          env.sig,
          env.cipherhead,
          pubKey,
        );
        if (sigValid) {
          const headHashHex = btoh(headHash);
          const headCombined = concat(concat(env.sig, env.kdm), env.cipherhead);
          await this.storage.setEnvelope(
            pubKeyHex,
            now,
            headCombined,
            env.cipherbody,
            headHashHex,
          );
          await this.notifier.notify(pubKeyHex);
          enc.writeBytes(new Uint8Array([Status.Success]));
        } else {
          enc.writeBytes(new Uint8Array([Status.InvalidSignature]));
        }
        enc.writeBytes(headHash);
      }
      return binResp(enc.result());
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };

  handlePull = async (pubKey: Uint8Array, dec: Decoder): Promise<Response> => {
    try {
      const pubKeyHex = btoh(pubKey);
      const enc = new Encoder();
      while (!dec.done()) {
        const headHash = dec.readBytes(hashSize);
        const headHashHex = btoh(headHash);
        const bodyCph = await this.storage.getBody(pubKeyHex, headHashHex);
        if (bodyCph) {
          enc.writeBytes(headHash);
          enc.writeVarInt(bodyCph.length);
          enc.writeBytes(bodyCph);
        }
      }
      return binResp(enc.result());
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };

  handlePeek = async (pubKey: Uint8Array, dec: Decoder): Promise<Response> => {
    try {
      const fromMillis = dec.readVarInt();
      if (!dec.done()) {
        return respFor(Status.ExtraBodyContent);
      }
      const begin = new Date(fromMillis).toISOString();
      const end = new Date().toISOString();

      const pubKeyHex = btoh(pubKey);
      const userHeadsList = await this.storage.listHeads(pubKeyHex, begin, end);

      const enc = new Encoder();
      for (const item of userHeadsList) {
        enc.writeBytes(item.sha256);
        enc.writeDate(new Date(item.recordedAt));
        enc.writeVarInt(item.headCph.length);
        enc.writeBytes(item.headCph);
      }
      return binResp(enc.result());
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
    const dec = new Decoder(data);
    const tsAuthBytes = dec.readBytes(tsAuthSize);
    const [pubKey, status] = await this.validateTsAuth(tsAuthBytes);
    if (status !== Status.Success) {
      return respFor(status);
    }

    if (request.method === "POST" && url.pathname === "/users") {
      return this.handleUser(pubKey, dec);
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
      return this.handlePush(pubKey, dec);
    }
    if (request.method === "POST" && url.pathname === "/pull") {
      return this.handlePull(pubKey, dec);
    }
    if (request.method === "POST" && url.pathname === "/peek") {
      return this.handlePeek(pubKey, dec);
    }

    return respFor(Status.NotFound);
  };
}
