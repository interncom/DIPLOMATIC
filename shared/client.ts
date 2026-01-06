import { makeAuthTimestamp } from "./auth.ts";
import { IClock } from "./clock.ts";
import { Encoder } from "./codec.ts";
import { Enclave } from "./enclave.ts";
import { hostKeys, IAuthenticatedEndpoint } from "./endpoint.ts";
import { api, post } from "./http.ts";
import { type IMessage } from "./message.ts";
import type { ICrypto, IHostConnectionInfo } from "./types.ts";

export default class DiplomaticClientAPI {
  constructor(
    public enclave: Enclave,
    public crypto: ICrypto,
    private host: IHostConnectionInfo,
    public clock: IClock,
  ) { }

  private async call<ReqItem, Resp>(
    apiCall: { path: string; endpoint: IAuthenticatedEndpoint<ReqItem, Resp> },
    items: Iterable<ReqItem>,
  ): Promise<Resp> {
    const { clock, crypto, host } = this;
    const { endpoint, path } = apiCall;

    const keys = await hostKeys(this, host.label, host.idx);

    const now = clock.now();
    const authTS = await makeAuthTimestamp(keys, now, crypto);

    const enc = new Encoder();
    await endpoint.encodeReq(this, keys, authTS, items, enc);

    const url = new URL(path, host.url);
    const dec = await post(url, enc);

    return endpoint.decodeResp(dec);
  }

  register = () => this.call(api.user, []);
  peek = (from: Date) => this.call(api.peek, [from]);
  push = (ops: IMessage[]) => this.call(api.push, ops);
  pull = (hashes: Uint8Array[]) => this.call(api.pull, hashes);
}

// Connect to websocket here.
