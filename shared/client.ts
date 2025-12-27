import type {
  ICrypto,
  IListDeltasResponse,
  IOperationRequest,
  IRegistrationRequest,
  KeyPair,
  IEnvelope,
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
} from "./envelope.ts";
import { Enclave } from "./enclave.ts";
import { timestampAuthProof } from "./auth.ts";
import { encodeOp, decodeOp, type IMessage, genKDM } from "./message.ts";
import { concat } from "./lib.ts";
import { Decoder, Encoder } from "./codec.ts";
import {
  HOST_PATH,
  USER_PATH,
  PUSH_PATH,
  PULL_PATH,
  PEEK_PATH,
  post,
} from "./http.ts";
import {
  type IEnvelopePeekItem,
  type IEnvelopePullItem,
  type IEnvelopePushItem,
  decodePullItem,
  decodePeekItem,
  decodePushItem,
} from "./protocol.ts";

export default class DiplomaticClientAPI {
  constructor(
    private enclave: Enclave,
    private crypto: ICrypto,
  ) {}

  async getHostID(hostURL: URL): Promise<string> {
    const url = new URL(HOST_PATH, hostURL);
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
    const derivSeed = await this.enclave.derive(keyPath, idx);
    const keyPair = await this.crypto.deriveEd25519KeyPair(derivSeed);
    const tsAuth = await timestampAuthProof(keyPair, now, this.crypto);

    const url = new URL(USER_PATH, hostURL);
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

    const derivSeed = await enclave.derive(keyPath, idx);
    const keyPair = await crypto.deriveEd25519KeyPair(derivSeed);
    const tsAuth = await timestampAuthProof(keyPair, now, crypto);
    const enc = new Encoder();
    enc.writeBytes(tsAuth);

    for (const op of ops) {
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
      const env = await makeEnvelope(keyPair, headCph, bodyCph, kdm, crypto);
      const envEnc = encodeEnvelope(env);

      enc.writeBytes(envEnc);
    }

    const url = new URL(PUSH_PATH, hostURL);
    const dec = await post(url, enc);
    const results: IEnvelopePushItem[] = [];
    while (!dec.done()) {
      const item = decodePushItem(dec);
      results.push(item);
    }
    return results;
  }

  async pull(
    hostURL: URL,
    hashes: Uint8Array[],
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IEnvelopePullItem[]> {
    const { crypto, enclave } = this;

    const derivSeed = await enclave.derive(keyPath, idx);
    const keyPair = await crypto.deriveEd25519KeyPair(derivSeed);
    const tsAuth = await timestampAuthProof(keyPair, now, crypto);

    const enc = new Encoder();
    enc.writeBytes(tsAuth);

    for (const hash of hashes) {
      enc.writeBytes(hash);
    }

    const url = new URL(PULL_PATH, hostURL);
    const dec = await post(url, enc);
    const items: IEnvelopePullItem[] = [];
    while (!dec.done()) {
      const item = decodePullItem(dec);
      items.push(item);
    }
    return items;
  }

  async peek(
    hostURL: URL,
    fromMillis: number,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IEnvelopePeekItem[]> {
    const { crypto, enclave } = this;

    const derivSeed = await enclave.derive(keyPath, idx);
    const keyPair = await crypto.deriveEd25519KeyPair(derivSeed);
    const tsAuth = await timestampAuthProof(keyPair, now, crypto);

    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    enc.writeVarInt(fromMillis);

    const url = new URL(PEEK_PATH, hostURL);
    const dec = await post(url, enc);
    const items: IEnvelopePeekItem[] = [];
    while (!dec.done()) {
      const item = decodePeekItem(dec);
      items.push(item);
    }
    return items;
  }
}
