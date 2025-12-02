import type {
  IHostCrypto,
  IListDeltasResponse,
  IMsgpackCodec,
  IOperationRequest,
  IRegistrationRequest,
  IStorage,
  IWebsocketNotifier,
} from "./types.ts";
import { btoh, htob, uint8ArraysEqual } from "./lib.ts";
import { decodeSigProvenData, type ISigProvenData } from "./sigProof.ts";
import { decodeEnvelope, type IEnvelope } from "./envelope.ts";

function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
}

class BufferManager {
  private buffer: Uint8Array = new Uint8Array(0);

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async readExactly(length: number): Promise<Uint8Array | null> {
    while (this.buffer.length < length) {
      const chunk = await this.reader.read();
      if (chunk.done) return null;
      this.buffer = concatUint8Arrays(this.buffer, chunk.value);
    }
    const result = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
    return result;
  }
}

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

export class DiplomaticServer {
  hostID: string;
  regToken: string;
  storage: IStorage;
  codec: IMsgpackCodec;
  crypto: IHostCrypto;
  notifier: IWebsocketNotifier;
  constructor(
    hostID: string,
    regToken: string,
    storage: IStorage,
    codec: IMsgpackCodec,
    crypto: IHostCrypto,
    notifier: IWebsocketNotifier,
  ) {
    this.hostID = hostID;
    this.regToken = regToken;
    this.storage = storage;
    this.codec = codec;
    this.crypto = crypto;
    this.notifier = notifier;
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
  ): Promise<number> {
    if (!uint8ArraysEqual(env.pubKey, expectedPubKey)) {
      return 1; // Pubkey mismatch
    }
    const hashSrc = new Uint8Array(env.len);
    const keyPathBytesData = new TextEncoder().encode(env.keyPath.slice(0, 8));
    hashSrc.set(keyPathBytesData.slice(0, 8), 0);
    hashSrc.set(env.msg, 8);
    const hash = await this.crypto.sha256Hash(hashSrc);
    if (!uint8ArraysEqual(hash, env.hsh)) {
      return 2; // Invalid hash
    }
    if (!(await this.crypto.checkSigEd25519(env.sig, env.hsh, env.pubKey))) {
      return 3; // Invalid envelope signature
    }
    await this.storage.setOp(pubKeyHex, now, env.msg);
    await this.notifier.notify(pubKeyHex);
    return 0; // Success
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
        const req = (await this.codec.decodeAsync(
          request.body,
        )) as IRegistrationRequest;
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
        const reader = request.body.getReader();
        const bufferManager = new BufferManager(reader);

        // Read tsAuth (fixed 120 bytes)
        const tsAuthBytes = await bufferManager.readExactly(120);
        if (!tsAuthBytes) {
          return new Response("Incomplete tsAuth", { status: 400 });
        }
        const tsAuth: ISigProvenData = decodeSigProvenData(tsAuthBytes);
        const pubKeyHex = btoh(tsAuth.pubKey);
        if (!(await this.storage.hasUser(pubKeyHex))) {
          return new Response("Unauthorized", { status: 401 });
        }
        const timestampMs = new DataView(tsAuth.data.buffer).getBigUint64(
          0,
          false,
        );
        const currentTime = Date.now();
        const diff = Math.abs(currentTime - Number(timestampMs));
        if (diff > 30000) {
          // 30 seconds tolerance
          return new Response("Clock out of sync", { status: 400 });
        }
        if (
          !(await this.crypto.checkSigEd25519(
            tsAuth.sig,
            tsAuth.data,
            tsAuth.pubKey,
          ))
        ) {
          return new Response("Invalid signature", { status: 401 });
        }

        let count = 0;
        while (true) {
          // Read envelope header (fixed 152 bytes)
          const headerBytes = await bufferManager.readExactly(152);
          if (!headerBytes) break; // End of stream

          // Parse len from header
          const view = new DataView(headerBytes.buffer, headerBytes.byteOffset);
          const len = Number(view.getBigUint64(144, false)); // lenOffset

          // Read envelope msg
          const msgBytes = await bufferManager.readExactly(len);
          if (!msgBytes) {
            return new Response("Incomplete envelope", { status: 400 });
          }

          // Combine header and msg for decoding
          const fullEnvelopeBytes = concatUint8Arrays(headerBytes, msgBytes);
          const env: IEnvelope = decodeEnvelope(fullEnvelopeBytes);

          const status = await this.processEnvelope(
            env,
            pubKeyHex,
            tsAuth.pubKey,
            now,
          );
          if (status !== 0) {
            return new Response(`Envelope error: ${status}`, { status: 400 });
          }
          count++;
        }
        return new Response(count.toString(), { status: 200 });
      } catch (err) {
        console.error(err);
        return new Response("Processing request", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}
