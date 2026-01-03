import { makeAuthTimestamp } from "./auth.ts";
import { IClock } from "./clock.ts";
import { Encoder } from "./codec.ts";
import { IAuthTimestamp } from "./codecs/authTimestamp.ts";
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
  authTS: IAuthTimestamp;
}

export default class DiplomaticClientAPI {
  constructor(
    public enclave: Enclave,
    public crypto: ICrypto,
    private hostURL: URL,
    private idx: number,
    private keyPath: string,
    public clock: IClock,
  ) {}

  private async authDataFor(
    now: Date,
  ): Promise<IAuthData> {
    const { crypto, enclave, keyPath, idx } = this;
    const derivSeed = await enclave.derive(keyPath, idx);
    const keys = await crypto.deriveEd25519KeyPair(derivSeed);
    const authTS = await makeAuthTimestamp(keys, now, crypto);
    return { keys: keys as HostSpecificKeyPair, authTS };
  }

  private async call<ReqItem, Resp>(
    apiCall: { path: string; endpoint: IAuthenticatedEndpoint<ReqItem, Resp> },
    items: Iterable<ReqItem>,
  ): Promise<Resp> {
    const { clock, hostURL } = this;
    const { keys, authTS } = await this.authDataFor(clock.now());
    const { endpoint, path } = apiCall;
    const enc = new Encoder();
    await endpoint.encodeReq(this, keys, authTS, items, enc);
    const url = new URL(path, hostURL);
    const dec = await post(url, enc);
    return endpoint.decodeResp(dec);
  }

  async register(): Promise<void> {
    return this.call(api.user, []);
  }

  async push(
    ops: IMessage[],
  ): Promise<IterableIterator<IBagPushItem>> {
    return this.call(api.push, ops);
  }

  async pull(
    hashes: Uint8Array[],
  ): Promise<IterableIterator<IBagPullItem>> {
    return this.call(api.pull, hashes);
  }

  async peek(
    from: Date,
  ): Promise<IterableIterator<IBagPeekItem>> {
    return this.call(api.peek, [from]);
  }
}
