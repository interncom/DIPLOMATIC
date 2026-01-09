import { makeAuthTimestamp } from "./auth.ts";
import { IClock } from "./clock.ts";
import { Encoder } from "./codec.ts";
import { APICallName } from "./consts.ts";
import { Enclave } from "./enclave.ts";
import { hostKeys, IAuthenticatedEndpoint } from "./endpoint.ts";
import { api } from "./http.ts";
import { type IMessage } from "./message.ts";
import type {
  HostHandle,
  HostSpecificKeyPair,
  ICrypto,
  IHostConnectionInfo,
  ITransport,
  PushReceiver,
} from "./types.ts";

export default class DiplomaticClientAPI<Handle extends HostHandle> {
  constructor(
    public enclave: Enclave,
    public crypto: ICrypto,
    private host: IHostConnectionInfo<Handle>,
    public clock: IClock,
    private transport: ITransport,
  ) { }

  private async call<ReqItem, Resp>(
    apiCall: {
      endpoint: IAuthenticatedEndpoint<ReqItem, Resp>;
      name: APICallName;
    },
    items: Iterable<ReqItem>,
  ): Promise<Resp> {
    const { clock, crypto, host, transport } = this;
    const { endpoint, name } = apiCall;

    const keys = await this.keys();

    const now = clock.now();
    const authTS = await makeAuthTimestamp(keys, now, crypto);

    const enc = new Encoder();
    await endpoint.encodeReq(this, keys, authTS, items, enc);

    const dec = await transport.call(name, enc);

    return endpoint.decodeResp(dec);
  }

  keys = (): Promise<HostSpecificKeyPair> => {
    const { host } = this;
    return hostKeys(this, host.label, host.idx);
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
