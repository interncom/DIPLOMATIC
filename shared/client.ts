import { makeAuthTimestamp } from "./auth.ts";
import { IClock } from "./clock.ts";
import { Encoder } from "./codec.ts";
import { APICallName } from "./consts.ts";
import { Enclave } from "./enclave.ts";
import { hostKeys, IAuthenticatedEndpoint } from "./endpoint.ts";
import { api } from "./http.ts";
import { type IMessage } from "./message.ts";
import type {
  ICrypto,
  IHostConnectionInfo,
  ITransport,
  PushReceiver,
} from "./types.ts";

export default class DiplomaticClientAPI {
  constructor(
    public enclave: Enclave,
    public crypto: ICrypto,
    private host: IHostConnectionInfo,
    public clock: IClock,
    private transport: ITransport,
  ) {}

  private async call<ReqItem, Resp>(
    apiCall: {
      endpoint: IAuthenticatedEndpoint<ReqItem, Resp>;
      name: APICallName;
    },
    items: Iterable<ReqItem>,
  ): Promise<Resp> {
    const { clock, crypto, host, transport } = this;
    const { endpoint, name } = apiCall;

    const keys = await hostKeys(this, host.label, host.idx);

    const now = clock.now();
    const authTS = await makeAuthTimestamp(keys, now, crypto);

    const enc = new Encoder();
    await endpoint.encodeReq(this, keys, authTS, items, enc);

    // TODO: use transport here (need to rephrase api const in terms of APICall enum)
    const dec = await transport.call(name, enc);

    return endpoint.decodeResp(dec);
  }

  register = () => this.call(api.user, []);
  peek = (from: Date) => this.call(api.peek, [from]);
  push = (ops: IMessage[]) => this.call(api.push, ops);
  pull = (hashes: Uint8Array[]) => this.call(api.pull, hashes);

  // listen for new bags.
  listen = async (recv: PushReceiver) => {
    const { host, transport } = this;
    const { listener } = transport;
    const keys = await hostKeys(this, host.label, host.idx);
    return listener.connect(keys.publicKey, recv);
  };
}
