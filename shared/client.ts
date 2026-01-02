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
    private hostURL: URL,
    private idx: number,
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
    keyPath: string,
    now: Date,
    items: Iterable<ReqItem>,
  ): Promise<Resp> {
    const { crypto, enclave, hostURL, idx } = this;
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const enc = await endpoint.encodeReq(tsAuth, items, keys, crypto, enclave);
    const url = new URL(path, hostURL);
    const dec = await post(url, enc);
    return endpoint.decodeResp(dec);
  }

  async getHostID(
    keyPath: string,
    now: Date,
  ): Promise<string> {
    return this.apiCall(hostEnd, apiPaths.host, keyPath, now, []);
  }

  async register(
    keyPath: string,
    now: Date,
  ): Promise<void> {
    return this.apiCall(userEnd, apiPaths.user, keyPath, now, []);
  }

  async push(
    ops: IMessage[],
    keyPath: string,
    now: Date,
  ): Promise<IterableIterator<IBagPushItem>> {
    return this.apiCall(pushEnd, apiPaths.push, keyPath, now, ops);
  }

  async pull(
    hashes: Uint8Array[],
    keyPath: string,
    now: Date,
  ): Promise<IterableIterator<IBagPullItem>> {
    return this.apiCall(pullEnd, apiPaths.pull, keyPath, now, hashes);
  }

  async peek(
    from: Date,
    keyPath: string,
    now: Date,
  ): Promise<IterableIterator<IBagPeekItem>> {
    return this.apiCall(peekEnd, apiPaths.peek, keyPath, now, [from]);
  }
}
