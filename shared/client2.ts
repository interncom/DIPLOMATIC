import type {
  ICrypto,
  IListDeltasResponse,
  IOperationRequest,
  IRegistrationRequest,
  KeyPair,
} from "./types.ts";
import { btoh } from "./lib.ts";
import {
  envelopeHeaderSize,
  hashSize,
  keyPathBytes,
  responseItemSize,
  tsAuthSize,
} from "./consts.ts";
import {
  makeEnvelope,
  encodeEnvelope,
  decodeEnvelopeHeader,
  decodeEnvelope,
  type IEnvelope,
  type IEnvelopeHeader,
} from "./envelope.ts";
import { timestampAuthProof } from "./auth.ts";
import {
  encodeOp,
  decodeOp,
  type IMessage,
  derivationKeyMaterial,
  concat,
} from "./message.ts";

export default class DiplomaticClientAPI {
  crypto: ICrypto;
  constructor(crypto: ICrypto) {
    this.crypto = crypto;
  }

  async getHostID(hostURL: URL): Promise<string> {
    const url = new URL(hostURL);
    url.pathname = "/id";
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw "Uh oh";
    }
    const id = await response.text();
    return id;
  }

  async register(
    hostURL: URL,
    seed: Uint8Array,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<void> {
    // Form the authentication prefix (sigproof of timestamp).
    // Server can reject for timestamp too far from its clock.
    // In that case, signal to user that clock is out of sync.
    // Clocks must be synchronized to ensure correct op order.
    const tsAuth = await timestampAuthProof(
      seed,
      keyPath,
      idx,
      now,
      this.crypto,
    );

    const url = new URL(hostURL);
    url.pathname = "/users";
    const response = await fetch(url, {
      method: "POST",
      body: tsAuth.slice(0),
    });
    if (!response.ok) {
      console.error(response);
      throw "Uh oh";
    }
    await response.body?.cancel();
  }

  async push(
    hostURL: URL,
    ops: IMessage[],
    seed: Uint8Array,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<Array<{ status: number; hash: Uint8Array }>> {
    const url = new URL(hostURL);
    url.pathname = "/ops";

    const keyPair = await this.crypto.deriveEd25519KeyPair(seed, keyPath, idx);

    // Form the authentication prefix (sigproof of timestamp).
    // Server can reject for timestamp too far from its clock.
    // In that case, signal to user that clock is out of sync.
    // Clocks must be synchronized to ensure correct op order.

    const tsAuth = await timestampAuthProof(
      seed,
      keyPath,
      idx,
      now,
      this.crypto,
    );

    // Create a readable stream to stream the data
    const stream = new ReadableStream({
      start: async (controller) => {
        // First, send the tsAuth data
        controller.enqueue(tsAuth);

        // Then, stream each envelope as it's generated
        for (const op of ops) {
          // Encode message.
          const [encMsg, msgHead] = await encodeOp(op);

          // Derive encryption key.
          const dkm = await derivationKeyMaterial(msgHead, this.crypto);
          const encKey = await this.crypto.blake3(concat(seed, dkm));

          // Encrypt message.
          const ciphertxt = await this.crypto.encryptXSalsa20Poly1305Combined(
            encMsg,
            encKey,
          );

          // Wrap in envelope.
          const env = await makeEnvelope(
            idx,
            keyPair,
            ciphertxt,
            dkm,
            this.crypto,
          );
          const encEnv = await encodeEnvelope(env);

          // Upload.
          controller.enqueue(encEnv);
        }
        controller.close();
      },
    });

    const response = await fetch(url, {
      method: "POST",
      body: stream,
    });
    if (!response.ok) {
      console.error(response);
      throw "Uh oh";
    }
    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    const results: { status: number; hash: Uint8Array }[] = [];
    for (let i = 0; i < data.length; i += responseItemSize) {
      const status = data[i];
      const hash = data.slice(i + 1, i + 1 + hashSize);
      results.push({ status, hash });
    }
    return results;
  }

  async pull(
    hostURL: URL,
    hashes: Uint8Array[],
    seed: Uint8Array,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IEnvelope[]> {
    const url = new URL(hostURL);
    url.pathname = "/pull";

    const tsAuth = await timestampAuthProof(
      seed,
      keyPath,
      idx,
      now,
      this.crypto,
    );

    const stream = new ReadableStream({
      start: (controller) => {
        controller.enqueue(tsAuth);
        for (const hash of hashes) {
          controller.enqueue(hash);
        }
        controller.close();
      },
    });

    const response = await fetch(url, {
      method: "POST",
      body: stream,
    });
    if (!response.ok) {
      throw "Uh oh";
    }
    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    const envelopes: IEnvelope[] = [];
    let offset = 0;

    while (offset < data.length) {
      if (offset + envelopeHeaderSize > data.length) break;
      const headerBytes = data.slice(offset, offset + envelopeHeaderSize);
      offset += envelopeHeaderSize;
      const envHeader = decodeEnvelopeHeader(headerBytes);
      const msgLen = envHeader.len - keyPathBytes;
      if (offset + msgLen > data.length) break;
      const msgBytes = data.slice(offset, offset + msgLen);
      offset += msgLen;
      const fullEnvelope = new Uint8Array(envelopeHeaderSize + msgLen);
      fullEnvelope.set(headerBytes, 0);
      fullEnvelope.set(msgBytes, envelopeHeaderSize);
      const env = decodeEnvelope(fullEnvelope);
      envelopes.push(env);
    }
    return envelopes;
  }

  async peek(
    hostURL: URL,
    fromMillis: number,
    seed: Uint8Array,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IEnvelopeHeader[]> {
    const url = new URL(hostURL);
    url.pathname = "/peek";
    url.searchParams.set("from", fromMillis.toString());

    const tsAuth = await timestampAuthProof(
      seed,
      keyPath,
      idx,
      now,
      this.crypto,
    );

    const response = await fetch(url, {
      method: "POST",
      body: tsAuth.slice(0),
    });
    if (!response.ok) {
      throw "Uh oh";
    }
    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    const headers: IEnvelopeHeader[] = [];
    let offset = 0;

    while (offset < data.length) {
      if (offset + envelopeHeaderSize > data.length) break;
      const headerBytes = data.slice(offset, offset + envelopeHeaderSize);
      offset += envelopeHeaderSize;
      const envHeader = decodeEnvelopeHeader(headerBytes);
      headers.push(envHeader);
    }
    return headers;
  }
}
