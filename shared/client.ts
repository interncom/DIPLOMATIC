import { hostEnd } from "./api/host.ts";
import { peekEnd } from "./api/peek.ts";
import { pullEnd } from "./api/pull.ts";
import { pushEnd } from "./api/push.ts";
import { userEnd } from "./api/user.ts";
import { type EncodedAuthTimestamp, timestampAuthProof } from "./auth.ts";
import { type IBagPeekItem } from "./codecs/peekItem.ts";
import { type IBagPullItem } from "./codecs/pullItem.ts";
import { type IBagPushItem } from "./codecs/pushItem.ts";
import { Enclave } from "./enclave.ts";
import { IAuthenticatedEndpoint } from "./endpoint.ts";
import { apiPaths, post } from "./http.ts";
import { type IMessage } from "./message.ts";
import type { HostSpecificKeyPair, ICrypto } from "./types.ts";

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

  private async apiCall<ReqItem, Resp>(
    endpoint: IAuthenticatedEndpoint<ReqItem, Resp>,
    path: string,
    hostURL: URL,
    keyPath: string,
    idx: number,
    now: Date,
    items: Iterable<ReqItem>,
  ): Promise<Resp> {
    const { crypto, enclave } = this;
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = await endpoint.encodeReq(tsAuth, items, keys, crypto, enclave);
    const url = new URL(path, hostURL);
    const dec = await post(url, enc);
    return endpoint.decodeResp(dec);
  }

  async getHostID(
    hostURL: URL,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<string> {
    return this.apiCall(hostEnd, apiPaths.host, hostURL, keyPath, idx, now, []);
  }

  async register(
    hostURL: URL,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<void> {
    return this.apiCall(userEnd, apiPaths.user, hostURL, keyPath, idx, now, []);
  }

  async push(
    hostURL: URL,
    ops: IMessage[],
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IterableIterator<IBagPushItem>> {
    const path = apiPaths.push;
    return this.apiCall(pushEnd, path, hostURL, keyPath, idx, now, ops);
  }

  async pull(
    hostURL: URL,
    hashes: Uint8Array[],
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IterableIterator<IBagPullItem>> {
    const path = apiPaths.pull;
    return this.apiCall(pullEnd, path, hostURL, keyPath, idx, now, hashes);
  }

  async peek(
    hostURL: URL,
    from: Date,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<IterableIterator<IBagPeekItem>> {
    const path = apiPaths.peek;
    return this.apiCall(peekEnd, path, hostURL, keyPath, idx, now, [from]);
  }
}
