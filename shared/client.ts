import type {
  ICrypto,
  IOperationRequest,
  IRegistrationRequest,
  KeyPair,
  IEnvelope,
} from "./types.ts";
import { btoh } from "./lib.ts";
import { makeEnvelope } from "./envelope.ts";
import { Enclave } from "./enclave.ts";
import { timestampAuthProof } from "./auth.ts";
import { encodeOp, decodeOp, type IMessage, genKDM } from "./message.ts";
import { concat } from "./lib.ts";
import { Decoder, Encoder } from "./codec.ts";
import { apiPaths, post } from "./http.ts";
import {
  type IEnvelopePeekItem,
  type IEnvelopePullItem,
  type IEnvelopePushItem,
  envelopePullItemCodec,
  envelopePushItemCodec,
  envelopePeekItemCodec,
  envelopeCodec,
} from "./protocol.ts";
import { type EncodedSigProvenData } from "./sigProof.ts";

export async function envelopeFor(
  op: IMessage,
  keyPair: KeyPair,
  crypto: ICrypto,
  enclave: Enclave,
): Promise<IEnvelope> {
  // Encode message.
  const [, head] = await encodeOp(op, crypto);

  // Derive encryption key.
  const kdm = await genKDM(crypto);
  const key = await enclave.deriveFromKDM(kdm);

  // Encrypt header and body separately, so that signed encrypted header may be served in PEEK response.
  const headCph = await crypto.encryptXSalsa20Poly1305Combined(head, key);
  const bodyCph = op.bod
    ? await crypto.encryptXSalsa20Poly1305Combined(op.bod, key)
    : new Uint8Array(0);

  // Wrap in envelope.
  return makeEnvelope(keyPair, headCph, bodyCph, kdm, crypto);
}

interface IAuthData {
  keyPair: KeyPair;
  tsAuth: EncodedSigProvenData;
}

export default class DiplomaticClientAPI {
  constructor(
    private enclave: Enclave,
    private crypto: ICrypto,
  ) {}

  private async authDataFor(keyPath: string, idx: number): Promise<IAuthData> {
    const { crypto, enclave } = this;
    const derivSeed = await enclave.derive(keyPath, idx);
    const keyPair = await crypto.deriveEd25519KeyPair(derivSeed);
    const tsAuth = await timestampAuthProof(keyPair, now, crypto);
    return { keyPair, tsAuth };
  }

  async getHostID(hostURL: URL): Promise<string> {
    const url = new URL(apiPaths.host, hostURL);
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
    const { tsAuth } = await this.authDataFor(keyPath, idx);
    const enc = new Encoder();
    enc.writeBytes(tsAuth);

    const url = new URL(apiPaths.user, hostURL);
    const dec = await post(url, enc);
  }

  async push(
    hostURL: URL,
    ops: IMessage[],
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IterableIterator<IEnvelopePushItem>> {
    const { crypto, enclave } = this;
    const { keyPair, tsAuth } = await this.authDataFor(keyPath, idx);

    const enc = new Encoder();
    enc.writeBytes(tsAuth);

    for (const op of ops) {
      const env = await envelopeFor(op, keyPair, crypto, enclave);
      enc.writeStruct(envelopeCodec, env);
    }

    const url = new URL(apiPaths.push, hostURL);
    const dec = await post(url, enc);
    return dec.readStructs(envelopePushItemCodec);
  }

  async pull(
    hostURL: URL,
    hashes: Uint8Array[],
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IterableIterator<IEnvelopePullItem>> {
    const { crypto, enclave } = this;
    const { tsAuth } = await this.authDataFor(keyPath, idx);

    const enc = new Encoder();
    enc.writeBytes(tsAuth);

    for (const hash of hashes) {
      enc.writeBytes(hash);
    }

    const url = new URL(apiPaths.pull, hostURL);
    const dec = await post(url, enc);
    return dec.readStructs(envelopePullItemCodec);
  }

  async peek(
    hostURL: URL,
    fromMillis: number,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IterableIterator<IEnvelopePeekItem>> {
    const { crypto, enclave } = this;
    const { tsAuth } = await this.authDataFor(keyPath, idx);

    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    enc.writeVarInt(fromMillis);

    const url = new URL(apiPaths.peek, hostURL);
    const dec = await post(url, enc);
    return dec.readStructs(envelopePeekItemCodec);
  }
}
