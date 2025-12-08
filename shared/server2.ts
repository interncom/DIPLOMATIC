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
import {
  tsAuthSize,
  envelopeHeaderSize,
  hashSize,
  responseItemSize,
  clockToleranceMs,
  keyPathBytes,
} from "./consts.ts";
import { decodeSigProvenData, type ISigProvenData } from "./sigProof.ts";
import {
  decodeEnvelope,
  decodeEnvelopeHeader,
  type IEnvelope,
  type IEnvelopeHeader,
} from "./envelope.ts";

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
    envHeader: IEnvelopeHeader,
    msg: Uint8Array,
    pubKeyHex: string,
    expectedPubKey: Uint8Array,
    now: Date,
    envelope: Uint8Array,
  ): Promise<number> {
    if (!uint8ArraysEqual(envHeader.pubKey, expectedPubKey)) {
      return 1; // Pubkey mismatch
    }
    const hashSrc = new Uint8Array(envHeader.len);
    const keyPathBytesData = new TextEncoder().encode(
      envHeader.keyPath.slice(0, keyPathBytes),
    );
    hashSrc.set(keyPathBytesData.slice(0, keyPathBytes), 0);
    hashSrc.set(msg, keyPathBytes);
    const hash = await this.crypto.sha256Hash(hashSrc);
    if (!uint8ArraysEqual(hash, envHeader.hsh)) {
      return 2; // Invalid hash
    }
    if (
      !(await this.crypto.checkSigEd25519(
        envHeader.sig,
        envHeader.hsh,
        envHeader.pubKey,
      ))
    ) {
      return 3; // Invalid envelope signature
    }
    await this.storage.setOp(pubKeyHex, now, envelope, btoh(envHeader.hsh));
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
      const body = request.body;
      if (!body) {
        return new Response("Invalid request", { status: 400 });
      }
      const bodyArrayBuffer = await request.arrayBuffer();
      const bodyView = new DataView(bodyArrayBuffer);
      let offset = 0;
      const now = new Date();
      try {
        // Read tsAuth
        if (offset + tsAuthSize > bodyArrayBuffer.byteLength) {
          return new Response("Incomplete tsAuth", { status: 400 });
        }
        const tsAuthBytes = new Uint8Array(
          bodyArrayBuffer.slice(offset, offset + tsAuthSize),
        );
        offset += tsAuthSize;
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
        if (diff > clockToleranceMs) {
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

        const results: { status: number; hsh: Uint8Array }[] = [];
        while (offset < bodyArrayBuffer.byteLength) {
          // Read envelope header
          if (offset + envelopeHeaderSize > bodyArrayBuffer.byteLength) {
            return new Response("Incomplete envelope header", { status: 400 });
          }
          const headerBytes = new Uint8Array(
            bodyArrayBuffer.slice(offset, offset + envelopeHeaderSize),
          );
          offset += envelopeHeaderSize;

          // Decode header
          const envHeader = decodeEnvelopeHeader(headerBytes);

          // Read envelope msg
          const msgLen = envHeader.len - keyPathBytes;
          if (offset + msgLen > bodyArrayBuffer.byteLength) {
            return new Response("Incomplete envelope", { status: 400 });
          }
          const msgBytes = new Uint8Array(
            bodyArrayBuffer.slice(offset, offset + msgLen),
          );
          offset += msgLen;

          const envelope = new Uint8Array(envelopeHeaderSize + msgLen);
          envelope.set(headerBytes, 0);
          envelope.set(msgBytes, envelopeHeaderSize);
          envelope.set(msgBytes, headerBytes.length);

          const status = await this.processEnvelope(
            envHeader,
            msgBytes,
            pubKeyHex,
            tsAuth.pubKey,
            now,
            envelope,
          );
          results.push({ status, hsh: envHeader.hsh });
        }
        const buffer = new Uint8Array(results.length * responseItemSize);
        let idx = 0;
        for (const result of results) {
          buffer[idx] = result.status;
          buffer.set(result.hsh, idx + 1);
          idx += responseItemSize;
        }
        return new Response(buffer, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      } catch (err) {
        console.error(err);
        return new Response("Internal error", { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/pull") {
      const body = request.body;
      if (!body) {
        return new Response("Invalid request", { status: 400 });
      }
      const bodyArrayBuffer = await request.arrayBuffer();
      const bodyView = new DataView(bodyArrayBuffer);
      let offset = 0;
      try {
        // Read tsAuth
        if (offset + tsAuthSize > bodyArrayBuffer.byteLength) {
          return new Response("Incomplete tsAuth", { status: 400 });
        }
        const tsAuthBytes = new Uint8Array(
          bodyArrayBuffer.slice(offset, offset + tsAuthSize),
        );
        offset += tsAuthSize;
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

        const hashes: Uint8Array[] = [];
        while (offset < bodyArrayBuffer.byteLength) {
          if (offset + hashSize > bodyArrayBuffer.byteLength) {
            return new Response("Incomplete hash", { status: 400 });
          }
          const hash = new Uint8Array(
            bodyArrayBuffer.slice(offset, offset + hashSize),
          );
          offset += hashSize;
          hashes.push(hash);
        }
        const results: Uint8Array[] = [];
        for (const hash of hashes) {
          const envelope = await this.storage.getOp(pubKeyHex, btoh(hash));
          if (envelope) {
            results.push(envelope);
          }
        }
        let totalLength = 0;
        for (const env of results) totalLength += env.length;
        const responseBody = new Uint8Array(totalLength);
        let pos = 0;
        for (const env of results) {
          responseBody.set(env, pos);
          pos += env.length;
        }
        return new Response(responseBody, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      } catch (err) {
        console.error(err);
        return new Response("Internal error", { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/peek") {
      const body = request.body;
      if (!body) {
        return new Response("Invalid request", { status: 400 });
      }
      const bodyArrayBuffer = await request.arrayBuffer();
      let offset = 0;
      try {
        // Read tsAuth
        if (offset + tsAuthSize > bodyArrayBuffer.byteLength) {
          return new Response("Incomplete tsAuth", { status: 400 });
        }
        const tsAuthBytes = new Uint8Array(
          bodyArrayBuffer.slice(offset, offset + tsAuthSize),
        );
        offset += tsAuthSize;
        // No other body content
        if (offset < bodyArrayBuffer.byteLength) {
          return new Response("Extra body content", { status: 400 });
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
        if (diff > clockToleranceMs) {
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
        // Get 'from' param
        const fromParam = url.searchParams.get("from");
        if (!fromParam) {
          return new Response("Missing from param", { status: 400 });
        }
        const fromMillis = parseInt(fromParam, 10);
        if (isNaN(fromMillis)) {
          return new Response("Invalid from param", { status: 400 });
        }
        const begin = new Date(fromMillis).toISOString();
        const end = new Date().toISOString();
        const userOpsList = await this.storage.listOps(pubKeyHex, begin, end);
        const headers: Uint8Array[] = [];
        for (const item of userOpsList) {
          const envelope = await this.storage.getOp(
            pubKeyHex,
            btoh(item.sha256),
          );
          if (envelope) {
            const header = envelope.slice(0, envelopeHeaderSize);
            headers.push(header);
          }
        }
        let totalLength = 0;
        for (const h of headers) totalLength += h.length;
        const responseBody = new Uint8Array(totalLength);
        let pos = 0;
        for (const h of headers) {
          responseBody.set(h, pos);
          pos += h.length;
        }
        return new Response(responseBody, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      } catch (err) {
        console.error(err);
        return new Response("Internal error", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}
