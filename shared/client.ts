import { type EncodedAuthTimestamp, timestampAuthProof } from "./auth.ts";
import { Encoder } from "./codec.ts";
import { bagCodec } from "./codecs/bag.ts";
import { type IBagPeekItem, peekItemCodec } from "./codecs/peekItem.ts";
import { type IBagPullItem, pullItemCodec } from "./codecs/pullItem.ts";
import { type IBagPushItem, pushItemCodec } from "./codecs/pushItem.ts";
import { Enclave } from "./enclave.ts";
import { sealBag } from "./bag.ts";
import { apiPaths, post } from "./http.ts";
import { type IMessage } from "./message.ts";
import type { HostSpecificKeyPair, ICrypto } from "./types.ts";
import { pushEnd } from "./api/push.ts";

interface IAuthData {
  keyPair: HostSpecificKeyPair;
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
    return { keyPair: keyPair as HostSpecificKeyPair, tsAuth };
  }

  async getHostID(
    hostURL: URL,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<string> {
    const { tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = new Encoder();
    enc.writeBytes(tsAuth);

    const url = new URL(apiPaths.host, hostURL);
    const dec = await post(url, enc);
    const len = dec.readVarInt();
    const bytes = dec.readBytes(len);
    return new TextDecoder().decode(bytes);
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
  ): Promise<IterableIterator<IBagPushItem>> {
    const { crypto, enclave } = this;
    const { keyPair, tsAuth } = await this.authDataFor(now, keyPath, idx);

    const enc = await pushEnd.encodeReq(tsAuth, ops, keyPair, crypto, enclave);
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
  ): Promise<IterableIterator<IBagPullItem>> {
    const { tsAuth } = await this.authDataFor(now, keyPath, idx);

    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    enc.writeBytesSeq(hashes);

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
  ): Promise<IterableIterator<IBagPeekItem>> {
    const { tsAuth } = await this.authDataFor(now, keyPath, idx);

    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    enc.writeDate(from);

    const url = new URL(apiPaths.peek, hostURL);
    const dec = await post(url, enc);
    return dec.readStructs(peekItemCodec);
  }
}
