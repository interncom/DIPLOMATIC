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
    const endpoint = hostEnd;
    const { crypto, enclave } = this;
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = await endpoint.encodeReq(tsAuth, [], keys, crypto, enclave);
    const url = new URL(apiPaths.host, hostURL);
    const dec = await post(url, enc);
    return hostEnd.decodeResp(dec);
  }

  async register(
    hostURL: URL,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<void> {
    const endpoint = userEnd;
    const { crypto, enclave } = this;
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = await endpoint.encodeReq(tsAuth, [], keys, crypto, enclave);
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
    const endpoint = pushEnd;
    const { crypto, enclave } = this;
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = await endpoint.encodeReq(tsAuth, ops, keys, crypto, enclave);
    const url = new URL(apiPaths.push, hostURL);
    const dec = await post(url, enc);
    return endpoint.decodeResp(dec);
  }

  async pull(
    hostURL: URL,
    hashes: Uint8Array[],
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IterableIterator<IBagPullItem>> {
    const endpoint = pullEnd;
    const { crypto, enclave } = this;
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = await endpoint.encodeReq(tsAuth, hashes, keys, crypto, enclave);
    const url = new URL(apiPaths.pull, hostURL);
    const dec = await post(url, enc);
    return endpoint.decodeResp(dec);
  }

  async peek(
    hostURL: URL,
    from: Date,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IterableIterator<IBagPeekItem>> {
    const endpoint = peekEnd;
    const { crypto, enclave } = this;
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = await endpoint.encodeReq(tsAuth, [from], keys, crypto, enclave);
    const url = new URL(apiPaths.peek, hostURL);
    const dec = await post(url, enc);
    return endpoint.decodeResp(dec);
  }
}
