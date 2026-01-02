import { type EncodedAuthTimestamp, timestampAuthProof } from "./auth.ts";
import { type IBagPeekItem } from "./codecs/peekItem.ts";
import { type IBagPullItem } from "./codecs/pullItem.ts";
import { type IBagPushItem } from "./codecs/pushItem.ts";
import { Enclave } from "./enclave.ts";
import { IAuthenticatedEndpoint } from "./endpoint.ts";
import { api, post } from "./http.ts";
import { type IMessage } from "./message.ts";
import type { HostSpecificKeyPair, ICrypto } from "./types.ts";

interface IAuthData {
  keys: HostSpecificKeyPair;
  tsAuth: EncodedAuthTimestamp;
}

export default class DiplomaticClientAPI {
  constructor(
    public enclave: Enclave,
    public crypto: ICrypto,
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

  private async call<ReqItem, Resp>(
    apiCall: { path: string; endpoint: IAuthenticatedEndpoint<ReqItem, Resp> },
    keyPath: string,
    now: Date,
    items: Iterable<ReqItem>,
  ): Promise<Resp> {
    const { hostURL, idx } = this;
    const { keys, tsAuth } = await this.authDataFor(now, keyPath, idx);
    const { endpoint, path } = apiCall;
    const enc = await endpoint.encodeReq(this, keys, tsAuth, items);
    const url = new URL(path, hostURL);
    const dec = await post(url, enc);
    return endpoint.decodeResp(dec);
  }

  async getHostID(
    keyPath: string,
    now: Date,
  ): Promise<string> {
    return this.call(api.host, keyPath, now, []);
  }

  async register(
    keyPath: string,
    now: Date,
  ): Promise<void> {
    return this.call(api.user, keyPath, now, []);
  }

  async push(
    ops: IMessage[],
    keyPath: string,
    now: Date,
  ): Promise<IterableIterator<IBagPushItem>> {
    return this.call(api.push, keyPath, now, ops);
  }

  async pull(
    hashes: Uint8Array[],
    keyPath: string,
    now: Date,
  ): Promise<IterableIterator<IBagPullItem>> {
    return this.call(api.pull, keyPath, now, hashes);
  }

  async peek(
    from: Date,
    keyPath: string,
    now: Date,
  ): Promise<IterableIterator<IBagPeekItem>> {
    return this.call(api.peek, keyPath, now, [from]);
  }
}
