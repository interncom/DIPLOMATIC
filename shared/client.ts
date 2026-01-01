import { type EncodedAuthTimestamp, timestampAuthProof } from "./auth.ts";
import { type IBagPeekItem, peekItemCodec } from "./codecs/peekItem.ts";
import { type IBagPullItem, pullItemCodec } from "./codecs/pullItem.ts";
import { type IBagPushItem, pushItemCodec } from "./codecs/pushItem.ts";
import { Enclave } from "./enclave.ts";
import { apiPaths, post } from "./http.ts";
import { type IMessage } from "./message.ts";
import type { HostSpecificKeyPair, ICrypto } from "./types.ts";
import { pushEnd } from "./api/push.ts";
import { hostEnd } from "./api/host.ts";
import { userEnd } from "./api/user.ts";
import { pullEnd } from "./api/pull.ts";
import { peekEnd } from "./api/peek.ts";

interface IAuthData {
  keys: HostSpecificKeyPair;
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
    const keys = await crypto.deriveEd25519KeyPair(derivSeed);
    const tsAuth = await timestampAuthProof(keys, now, crypto);
    return { keys: keys as HostSpecificKeyPair, tsAuth };
  }

  async getHostID(
    hostURL: URL,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<string> {
    const { crypto, enclave } = this;
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = await hostEnd.encodeReq(tsAuth, [], keys, crypto, enclave);
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
    const { crypto, enclave } = this;
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = await userEnd.encodeReq(tsAuth, [], keys, crypto, enclave);
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
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = await pushEnd.encodeReq(tsAuth, ops, keys, crypto, enclave);
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
    const { crypto, enclave } = this;
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = await pullEnd.encodeReq(tsAuth, hashes, keys, crypto, enclave);
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
    const { crypto, enclave } = this;
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = await peekEnd.encodeReq(tsAuth, [from], keys, crypto, enclave);
    const url = new URL(apiPaths.peek, hostURL);
    const dec = await post(url, enc);
    return dec.readStructs(peekItemCodec);
  }
}
