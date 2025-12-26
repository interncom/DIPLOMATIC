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
} from "./envelope.ts";

export interface IEnvelopePeekItem {
  hash: Uint8Array;
  recordedAt: number;
}

import { Enclave } from "./enclave.ts";
import { timestampAuthProof } from "./auth.ts";
import { encodeOp, decodeOp, type IMessage, genKDM } from "./message.ts";
import { concat } from "./lib.ts";
import { Decoder, Encoder } from "./codec.ts";

async function post(url: URL, enc: Encoder) {
  return fetch(url, {
    method: "POST",
    body: enc.result().slice(),
  });
}

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
    const url = new URL("/id", hostURL);
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
    const derivationSeed = await this.enclave.derive(keyPath, idx);
    const tsAuth = await timestampAuthProof(derivationSeed, now, this.crypto);

    const url = new URL("/users", hostURL);
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
    const { crypto, enclave } = this;

    const derivationSeed = await enclave.derive(keyPath, idx);
    const tsAuth = await timestampAuthProof(derivationSeed, now, crypto);
    const encoder = new Encoder();
    encoder.writeBytes(tsAuth);

    const keyPair = await crypto.deriveEd25519KeyPair(derivationSeed);
    for (const op of ops) {
      // Encode message.
      const [encMsg, head] = await encodeOp(op, crypto);

      // Derive encryption key.
      const kdm = await genKDM(crypto);
      const key = await enclave.deriveFromKDM(kdm);

      // Encrypt header and body separately, so that signed encrypted header may be served in PEEK response.
      const headCry = await crypto.encryptXSalsa20Poly1305Combined(head, key);
      const bodyCry = op.bod
        ? await crypto.encryptXSalsa20Poly1305Combined(op.bod, key)
        : new Uint8Array(0);

      // Wrap in envelope.
      const env = await makeEnvelope(keyPair, headCry, bodyCry, kdm, crypto);
      const encEnv = encodeEnvelope(env);

      encoder.writeBytes(encEnv);
    }

    const url = new URL("/ops", hostURL);
    const response = await post(url, encoder);
    if (!response.ok) {
      console.error(response);
      throw "Uh oh";
    }
    const arrayBuffer = await response.arrayBuffer();
    const responseData = new Uint8Array(arrayBuffer);
    const decoder = new Decoder(responseData);
    const results: { status: number; hash: Uint8Array }[] = [];
    while (!decoder.done()) {
      const status = decoder.readBytes(1)[0];
      const hash = decoder.readBytes(hashSize);
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
    const derivationSeed = await this.enclave.derive(keyPath, idx);
    const tsAuth = await timestampAuthProof(derivationSeed, now, this.crypto);

    const encoder = new Encoder();
    encoder.writeBytes(tsAuth);
    for (const hash of hashes) {
      encoder.writeBytes(hash);
    }

    const url = new URL("/pull", hostURL);
    const response = await post(url, encoder);
    if (!response.ok) {
      throw "Uh oh";
    }
    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    const envelopes: IEnvelope[] = [];
    let offset = 0;
    while (offset < data.length) {
      const decoder = new Decoder(data.slice(offset));
      const envelope = decodeEnvelope(decoder);
      envelopes.push(envelope);
      offset += decoder.consumed();
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
    const derivationSeed = await this.enclave.derive(keyPath, idx);
    const tsAuth = await timestampAuthProof(derivationSeed, now, this.crypto);

    const encoder = new Encoder();
    encoder.writeBytes(tsAuth);
    encoder.writeVarInt(fromMillis);

    const url = new URL("/peek", hostURL);
    const response = await post(url, encoder);
    if (!response.ok) {
      throw "Uh oh";
    }
    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    const decoder = new Decoder(data);
    const items: IEnvelopePeekItem[] = [];
    while (!decoder.done()) {
      const hash = decoder.readBytes(hashSize);
      const recordedAtBigInt = decoder.readBigInt();
      const recordedAt = Number(recordedAtBigInt);
      items.push({ hash, recordedAt });
    }
    return items;
  }
}
