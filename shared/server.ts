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
import { decode_varint } from "./varint.ts";

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

  async validateTsAuth(
    tsAuthBytes: Uint8Array,
  ): Promise<{ pubKey: Uint8Array; pubKeyHex: string }> {
    const tsAuth: ISigProvenData = decodeSigProvenData(tsAuthBytes);
    const timestampMs = new DataView(tsAuth.data.buffer).getBigUint64(0, false);
    const currentTime = Date.now();
    const diff = Math.abs(currentTime - Number(timestampMs));
    if (diff > clockToleranceMs) {
      throw new Error("Clock out of sync");
    }
    if (
      !(await this.crypto.checkSigEd25519(
        tsAuth.sig,
        tsAuth.data,
        tsAuth.pubKey,
      ))
    ) {
      throw new Error("Invalid signature");
    }
    const pubKeyHex = btoh(tsAuth.pubKey);
    return { pubKey: tsAuth.pubKey, pubKeyHex };
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
    if (
      !(await this.crypto.checkSigEd25519(
        env.sig,
        env.cipherhead,
        expectedPubKey,
      ))
    ) {
      return 3; // Invalid envelope signature
    }
    const envelope = encodeEnvelope(env);
    const hsh = await this.crypto.sha256Hash(
      concat(env.cipherhead, env.cipherbody),
    );
    await this.storage.setOp(pubKeyHex, now, envelope, btoh(hsh));
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
        const bodyArrayBuffer = await request.arrayBuffer();
        let offset = 0;
        // Read tsAuth
        if (offset + tsAuthSize > bodyArrayBuffer.byteLength) {
          return new Response("Incomplete tsAuth", { status: 400 });
        }
        const tsAuthBytes = new Uint8Array(
          bodyArrayBuffer.slice(offset, offset + tsAuthSize),
        );
        offset += tsAuthSize;
        // No more data expected
        if (offset < bodyArrayBuffer.byteLength) {
          return new Response("Extra body content", { status: 400 });
        }
        const { pubKeyHex } = await this.validateTsAuth(tsAuthBytes);
        // Register the public key
        await this.storage.addUser(pubKeyHex);
        return new Response("", { status: 200 });
      } catch (err) {
        if (err instanceof Error) {
          if (err.message === "Invalid signature") {
            return new Response(err.message, { status: 401 });
          }
          return new Response(err.message, { status: 400 });
        }
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
      const data = new Uint8Array(bodyArrayBuffer);
      let offset = 0;
      const now = new Date();
      try {
        // Read tsAuth
        if (offset + tsAuthSize > data.length) {
          return new Response("Incomplete tsAuth", { status: 400 });
        }
        const tsAuthBytes = data.slice(offset, offset + tsAuthSize);
        offset += tsAuthSize;
        const { pubKey, pubKeyHex } = await this.validateTsAuth(tsAuthBytes);
        if (!(await this.storage.hasUser(pubKeyHex))) {
          return new Response("Unauthorized", { status: 401 });
        }

        const results: { status: number; hsh: Uint8Array }[] = [];
        while (offset < data.length) {
          // Read sig
          if (offset + 64 > data.length) break;
          const sig = data.slice(offset, offset + 64);
          offset += 64;
          // Read dkm
          if (offset + 8 > data.length) break;
          const dkm = data.slice(offset, offset + 8);
          offset += 8;
          // Read varint lenCipherHead
          const headLenDecode = decode_varint(data, offset);
          const lenCipherHead = Number(headLenDecode.value);
          offset += headLenDecode.bytesRead;
          // Read varint lenCipherBody
          const bodyLenDecode = decode_varint(data, offset);
          const lenCipherBody = Number(bodyLenDecode.value);
          offset += bodyLenDecode.bytesRead;
          // Read cipherhead
          if (offset + lenCipherHead > data.length) break;
          const cipherhead = data.slice(offset, offset + lenCipherHead);
          offset += lenCipherHead;
          // Read cipherbody
          if (offset + lenCipherBody > data.length) break;
          const cipherbody = data.slice(offset, offset + lenCipherBody);
          offset += lenCipherBody;
          const env: IEnvelope = {
            sig,
            dkm,
            lenCipherHead,
            lenCipherBody,
            cipherhead,
            cipherbody,
          };
          const status = await this.processEnvelope(
            env,
            pubKeyHex,
            pubKey,
            now,
          );
          const hsh = await this.crypto.sha256Hash(
            concat(cipherhead, cipherbody),
          );
          results.push({ status, hsh });
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
        if (err instanceof Error) {
          if (err.message === "Invalid signature") {
            return new Response(err.message, { status: 401 });
          }
          return new Response(err.message, { status: 400 });
        }
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
        const { pubKeyHex } = await this.validateTsAuth(tsAuthBytes);
        if (!(await this.storage.hasUser(pubKeyHex))) {
          return new Response("Unauthorized", { status: 401 });
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
          const hashHex = btoh(hash);
          const envelope = await this.storage.getOp(pubKeyHex, hashHex);
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
        if (err instanceof Error) {
          if (err.message === "Invalid signature") {
            return new Response(err.message, { status: 401 });
          }
          return new Response(err.message, { status: 400 });
        }
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
        const { pubKeyHex } = await this.validateTsAuth(tsAuthBytes);
        if (!(await this.storage.hasUser(pubKeyHex))) {
          return new Response("Unauthorized", { status: 401 });
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
        const responseData: Uint8Array[] = [];
        for (const item of userOpsList) {
          const hash = item.sha256;
          const recordedAtBytes = new Uint8Array(8);
          new DataView(recordedAtBytes.buffer).setBigUint64(
            0,
            BigInt(new Date(item.recordedAt).getTime()),
            false,
          );
          responseData.push(hash, recordedAtBytes);
        }
        const totalLength = responseData.reduce(
          (sum, arr) => sum + arr.length,
          0,
        );
        const responseBody = new Uint8Array(totalLength);
        let pos = 0;
        for (const arr of responseData) {
          responseBody.set(arr, pos);
          pos += arr.length;
        }
        return new Response(responseBody, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      } catch (err) {
        if (err instanceof Error) {
          if (err.message === "Invalid signature") {
            return new Response(err.message, { status: 401 });
          }
          return new Response(err.message, { status: 400 });
        }
        console.error(err);
        return new Response("Internal error", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}
