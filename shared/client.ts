import { makeAuthTimestamp } from "./auth.ts";
import { IClock } from "./clock.ts";
import { Encoder } from "./codec.ts";
import { IAuthTimestamp } from "./codecs/authTimestamp.ts";
import { Enclave } from "./enclave.ts";
import { hostKeys, IAuthenticatedEndpoint } from "./endpoint.ts";
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

  private async call<ReqItem, Resp>(
    apiCall: { path: string; endpoint: IAuthenticatedEndpoint<ReqItem, Resp> },
    items: Iterable<ReqItem>,
  ): Promise<Resp> {
    const { clock, crypto, hostURL, idx, keyPath } = this;
    const { endpoint, path } = apiCall;

    const keys = await hostKeys(this, keyPath, idx);

    const now = clock.now();
    const authTS = await makeAuthTimestamp(keys, now, crypto);

    const enc = new Encoder();
    await endpoint.encodeReq(this, keys, authTS, items, enc);

    const url = new URL(path, hostURL);
    const dec = await post(url, enc);

    return endpoint.decodeResp(dec);
  }

  register = () => this.call(api.user, []);
  peek = (from: Date) => this.call(api.peek, [from]);
  push = (ops: IMessage[]) => this.call(api.push, ops);
  pull = (hashes: Uint8Array[]) => this.call(api.pull, hashes);
}
