import { type EncodedAuthTimestamp, timestampAuthProof } from "./auth.ts";
import { Encoder } from "./codec.ts";
import { envelopeCodec } from "./codecs/envelope.ts";
import { type IEnvelopePeekItem, peekItemCodec } from "./codecs/peekItem.ts";
import { type IEnvelopePullItem, pullItemCodec } from "./codecs/pullItem.ts";
import { type IEnvelopePushItem, pushItemCodec } from "./codecs/pushItem.ts";
import { Enclave } from "./enclave.ts";
import { envelopeFor } from "./envelope.ts";
import { apiPaths, post } from "./http.ts";
import { type IMessage } from "./message.ts";
import type { ICrypto, KeyPair } from "./types.ts";

interface IAuthData {
  keyPair: KeyPair;
  tsAuth: EncodedAuthTimestamp;
}

export default class DiplomaticClientAPI {
  constructor(
    private enclave: Enclave,
    private crypto: ICrypto,
  ) {}

  private async authDataFor(
    now: Date,
    keyPath: string,
    idx: number,
  ): Promise<IAuthData> {
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
    const { tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = new Encoder();
    enc.writeBytes(tsAuth);

    const url = new URL(apiPaths.user, hostURL);
    await post(url, enc);
  }

  async push(
    hostURL: URL,
    ops: IMessage[],
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IterableIterator<IEnvelopePushItem>> {
    const { crypto, enclave } = this;
    const { keyPair, tsAuth } = await this.authDataFor(now, keyPath, idx);

    const enc = new Encoder();
    enc.writeBytes(tsAuth);

    for (const op of ops) {
      const env = await envelopeFor(op, keyPair, crypto, enclave);
      enc.writeStruct(envelopeCodec, env);
    }

    const url = new URL(apiPaths.push, hostURL);
    const dec = await post(url, enc);
    return dec.readStructs(pushItemCodec);
  }

  async pull(
    hostURL: URL,
    hashes: Uint8Array[],
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IterableIterator<IEnvelopePullItem>> {
    const { tsAuth } = await this.authDataFor(now, keyPath, idx);

    const enc = new Encoder();
    enc.writeBytes(tsAuth);

    for (const hash of hashes) {
      enc.writeBytes(hash);
    }

    const url = new URL(apiPaths.pull, hostURL);
    const dec = await post(url, enc);
    return dec.readStructs(pullItemCodec);
  }

  async peek(
    hostURL: URL,
    from: Date,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IterableIterator<IEnvelopePeekItem>> {
    const { tsAuth } = await this.authDataFor(now, keyPath, idx);

    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    enc.writeDate(from);

    const url = new URL(apiPaths.peek, hostURL);
    const dec = await post(url, enc);
    return dec.readStructs(peekItemCodec);
  }
}
