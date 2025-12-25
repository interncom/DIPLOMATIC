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
} from "./message.ts";
import { concat } from "./lib.ts";
import { Decoder, Encoder } from "./codec.ts";

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

    const encoder = new Encoder();
    encoder.writeBytes(tsAuth);
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

      encoder.writeBytes(encEnv);
    }

    const response = await fetch(url, {
      method: "POST",
      body: encoder.result().slice(),
    });
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
    const url = new URL(hostURL);
    url.pathname = "/pull";

    const derivationSeed = await this.enclave.derive(keyPath, idx);
    const tsAuth = await timestampAuthProof(derivationSeed, now, this.crypto);

    const encoder = new Encoder();
    encoder.writeBytes(tsAuth);
    for (const hash of hashes) {
      encoder.writeBytes(hash);
    }

    const response = await fetch(url, {
      method: "POST",
      body: encoder.result().slice(),
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
