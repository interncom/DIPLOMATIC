import { type EncodedAuthTimestamp, timestampAuthProof } from "./auth.ts";
import { IClock } from "./clock.ts";
import { Encoder } from "./codec.ts";
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
    public clock: IClock,
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
    items: Iterable<ReqItem>,
  ): Promise<Resp> {
    const { clock, hostURL, idx } = this;
    const { keys, tsAuth } = await this.authDataFor(clock.now(), keyPath, idx);
    const { endpoint, path } = apiCall;
    const enc = new Encoder();
    await endpoint.encodeReq(this, keys, tsAuth, items, enc);
    const url = new URL(path, hostURL);
    const dec = await post(url, enc);
    return endpoint.decodeResp(dec);
  }

  async getHostID(keyPath: string): Promise<string> {
    return this.call(api.host, keyPath, []);
  }

  async register(keyPath: string): Promise<void> {
    return this.call(api.user, keyPath, []);
  }

  async push(
    ops: IMessage[],
    keyPath: string,
  ): Promise<IterableIterator<IBagPushItem>> {
    return this.call(api.push, keyPath, ops);
  }

  async pull(
    hashes: Uint8Array[],
    keyPath: string,
  ): Promise<IterableIterator<IBagPullItem>> {
    return this.call(api.pull, keyPath, hashes);
  }

  async peek(
    from: Date,
    keyPath: string,
  ): Promise<IterableIterator<IBagPeekItem>> {
    return this.call(api.peek, keyPath, [from]);
  }
}
