import type {
  ICrypto,
  IListDeltasResponse,
  IOperationRequest,
  IRegistrationRequest,
  KeyPair,
  DerivationSeed,
} from "./types.ts";
import { btoh } from "./lib.ts";
import {
  envelopeHeaderSize,
  hashSize,
  hashBytes,
  lenBytes,
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

export interface IEnvelopePeekItem {
  hash: Uint8Array;
  recordedAt: number;
}

import { Enclave } from "./enclave.ts";
import { timestampAuthProof } from "./auth.ts";
import {
  encodeOp,
  decodeOp,
  type IMessage,
  derivationKeyMaterial,
  concat,
} from "./message.ts";

import { decode_varint } from "./varint.ts";

export default class DiplomaticClientAPI {
  crypto: ICrypto;
  enclave: Enclave;

  constructor(enclave: Enclave, crypto: ICrypto) {
    this.crypto = crypto;
    this.enclave = enclave;
  }

  async getKeyPair(keyPath: string, idx: number): Promise<KeyPair> {
    const derivationSeed = await this.enclave.derive(keyPath, idx);
    return await this.crypto.deriveEd25519KeyPair(derivationSeed);
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
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<void> {
    // Form the authentication prefix (sigproof of timestamp).
    // Server can reject for timestamp too far from its clock.
    // In that case, signal to user that clock is out of sync.
    // Clocks must be synchronized to ensure correct op order.
    const derivationSeed = await this.enclave.derive(keyPath, idx);
    const tsAuth = await timestampAuthProof(derivationSeed, now, this.crypto);

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
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<Array<{ status: number; hash: Uint8Array }>> {
    const url = new URL(hostURL);
    url.pathname = "/ops";

    const derivationSeed = await this.enclave.derive(keyPath, idx);
    const keyPair = await this.crypto.deriveEd25519KeyPair(derivationSeed);

    // Form the authentication prefix (sigproof of timestamp).
    // Server can reject for timestamp too far from its clock.
    // In that case, signal to user that clock is out of sync.
    // Clocks must be synchronized to ensure correct op order.

    const tsAuth = await timestampAuthProof(derivationSeed, now, this.crypto);

    // Collect all data into a buffer
    let data = new Uint8Array(tsAuthSize);
    data.set(tsAuth, 0);
    let offset = tsAuthSize;
    for (const op of ops) {
      // Encode message.
      const [encMsg, msgHead] = await encodeOp(op, this.crypto);

      // Derive encryption key.
      const dkm = (await derivationKeyMaterial(this.crypto)).slice(0, 8);
      const encKey = await this.enclave.deriveFromKDM(dkm);

      // Encrypt header and body separately.
      const cipherhead = await this.crypto.encryptXSalsa20Poly1305Combined(
        msgHead,
        encKey,
      );
      const cipherbody = op.bod
        ? await this.crypto.encryptXSalsa20Poly1305Combined(op.bod, encKey)
        : new Uint8Array(0);

      // Wrap in envelope.
      const env = await makeEnvelope(
        keyPair,
        cipherhead,
        cipherbody,
        dkm,
        this.crypto,
      );
      const encEnv = encodeEnvelope(env);

      // Append to data buffer.
      const newData = new Uint8Array(data.length + encEnv.length);
      newData.set(data, 0);
      newData.set(encEnv, offset);
      data = newData;
      offset += encEnv.length;
    }

    const response = await fetch(url, {
      method: "POST",
      body: data,
    });
    if (!response.ok) {
      console.error(response);
      throw "Uh oh";
    }
    const arrayBuffer = await response.arrayBuffer();
    const responseData = new Uint8Array(arrayBuffer);
    const results: { status: number; hash: Uint8Array }[] = [];
    for (let i = 0; i < responseData.length; i += responseItemSize) {
      const status = responseData[i];
      const hash = responseData.slice(i + 1, i + 1 + hashSize);
      results.push({ status, hash });
    }
    return results;
  }

  async pull(
    hostURL: URL,
    hashes: Uint8Array[],
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IEnvelope[]> {
    const url = new URL(hostURL);
    url.pathname = "/pull";

    const derivationSeed = await this.enclave.derive(keyPath, idx);
    const tsAuth = await timestampAuthProof(derivationSeed, now, this.crypto);

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
      const result = decodeEnvelope(data.slice(offset));
      envelopes.push(result.envelope);
      offset += result.consumed;
    }
    return envelopes;
  }

  async peek(
    hostURL: URL,
    fromMillis: number,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IEnvelopePeekItem[]> {
    const url = new URL(hostURL);
    url.pathname = "/peek";
    url.searchParams.set("from", fromMillis.toString());

    const derivationSeed = await this.enclave.derive(keyPath, idx);
    const tsAuth = await timestampAuthProof(derivationSeed, now, this.crypto);

    const response = await fetch(url, {
      method: "POST",
      body: tsAuth.slice(0),
    });
    if (!response.ok) {
      throw "Uh oh";
    }
    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    const items: IEnvelopePeekItem[] = [];
    let offset = 0;
    const itemSize = hashSize + lenBytes;

    while (offset < data.length) {
      if (offset + itemSize > data.length) break;
      const hash = data.slice(offset, offset + hashSize);
      const recordedAt = Number(
        new DataView(data.buffer, offset + hashSize).getBigUint64(0, false),
      );
      offset += itemSize;
      items.push({ hash, recordedAt });
    }
    return items;
  }
}
