import type {
  IHostCrypto,
  IListDeltasResponse,
  IOperationRequest,
  IRegistrationRequest,
  IStorage,
  IWebsocketNotifier,
  PublicKey,
} from "./types.ts";
import { btoh, htob, uint8ArraysEqual } from "./lib.ts";
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
import {
  HOST_PATH,
  USER_PATH,
  PUSH_PATH,
  PULL_PATH,
  PEEK_PATH,
  respFor,
  binResp,
  cors,
} from "./http.ts";
import { Status } from "./consts.ts";

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

  async validateTsAuth(tsAuthBytes: Uint8Array): Promise<[PublicKey, Status]> {
    const tsAuth = decodeSigProvenData(tsAuthBytes);
    const timestampMs = new DataView(tsAuth.data.buffer).getBigUint64(0, false);
    const currentTime = Date.now();
    const diff = Math.abs(currentTime - Number(timestampMs));
    if (diff > clockToleranceMs) {
      return [new Uint8Array(0) as PublicKey, Status.ClockOutOfSync];
    }
    const sigValid = await this.crypto.checkSigEd25519(
      tsAuth.sig,
      tsAuth.data,
      tsAuth.pubKey,
    );
    if (!sigValid) {
      return [new Uint8Array(0) as PublicKey, Status.InvalidSignature];
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

  handleUser = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    if (!dec.done()) {
      return respFor(Status.ExtraBodyContent);
    }
    try {
      // Register the public key
      await this.storage.addUser(pubKey);
      return new Response("", { status: 200 });
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };

  handlePush = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const { crypto, notifier, storage } = this;
    const now = new Date();
    try {
      const enc = new Encoder();
      while (!dec.done()) {
        const env = decodeEnvelope(dec);
        const headHash = await crypto.sha256Hash(env.headCph);
        const sigValid = await crypto.checkSigEd25519(
          env.sig,
          env.headCph,
          pubKey,
        );
        if (sigValid) {
          await storage.setEnvelope(pubKey, now, env, headHash);
          await notifier.notify(pubKey as PublicKey);
          enc.writeBytes(new Uint8Array([Status.Success]));
        } else {
          enc.writeBytes(new Uint8Array([Status.InvalidSignature]));
        }
        enc.writeBytes(headHash);
      }
      return binResp(enc);
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };

  handlePull = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    try {
      const enc = new Encoder();
      while (!dec.done()) {
        const headHash = dec.readBytes(hashSize);
        const bodyCph = await this.storage.getBody(pubKey, headHash);
        if (bodyCph) {
          enc.writeBytes(headHash);
          enc.writeVarInt(bodyCph.length);
          enc.writeBytes(bodyCph);
        }
      }
      return binResp(enc);
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };

  handlePeek = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    try {
      const fromMillis = dec.readVarInt();
      if (!dec.done()) {
        return respFor(Status.ExtraBodyContent);
      }
      const begin = new Date(fromMillis).toISOString();
      const end = new Date().toISOString();

      const userHeadsList = await this.storage.listHeads(pubKey, begin, end);

      const enc = new Encoder();
      for (const item of userHeadsList) {
        enc.writeBytes(item.sha256);
        enc.writeDate(new Date(item.recordedAt));
        enc.writeVarInt(item.headCph.length);
        enc.writeBytes(item.headCph);
      }
      return binResp(enc);
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };

  handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === HOST_PATH) {
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
    const result = await this.validateTsAuth(tsAuthBytes);
    if (result[1] !== Status.Success) {
      return respFor(result[1]);
    }
    const pubKey: PublicKey = result[0];

    if (request.method === "POST" && url.pathname === USER_PATH) {
      return this.handleUser(pubKey, dec);
    }

    // Registered user required beyond this point.
    try {
      const userRegistered = await this.storage.hasUser(pubKey);
      if (!userRegistered) {
        return respFor(Status.UserNotRegistered);
      }
    } catch {
      return respFor(Status.InternalError);
    }

    if (request.method === "POST" && url.pathname === PUSH_PATH) {
      return this.handlePush(pubKey, dec);
    }
    if (request.method === "POST" && url.pathname === PULL_PATH) {
      return this.handlePull(pubKey, dec);
    }
    if (request.method === "POST" && url.pathname === PEEK_PATH) {
      return this.handlePeek(pubKey, dec);
    }

    return respFor(Status.NotFound);
  };
}
