import { makeAuthTimestamp } from "./auth.ts";
import { sealBag } from "./bag.ts";
import { IClock, offset } from "./clock.ts";
import { Encoder } from "./codec.ts";
import { respHeadCodec } from "./codecs/respHead.ts";
import { APICallName, Status } from "./consts.ts";
import { Enclave } from "./enclave.ts";
import { hostKeys, IAuthenticatedEndpoint } from "./endpoint.ts";
import { api } from "./http.ts";
import type {
  Hash,
  HostHandle,
  HostSpecificKeyPair,
  IBag,
  ICrypto,
  IHostConnectionInfo,
  IHostMetadata,
  IMessage,
  ITransport,
  PushReceiver,
} from "./types.ts";
import { err, ValStat } from "./valstat.ts";

export default class DiplomaticClientAPI<Handle extends HostHandle> {
  constructor(
    public enclave: Enclave,
    public crypto: ICrypto,
    private host: IHostConnectionInfo<Handle>,
    public clock: IClock,
    private transport: ITransport,
    private updateHostMeta: (meta: IHostMetadata) => Promise<Status>,
  ) { }

  private async call<ReqItem, Resp>(
    apiCall: {
      endpoint: IAuthenticatedEndpoint<ReqItem, Resp>;
      name: APICallName;
    },
    items: Iterable<ReqItem>,
  ): Promise<ValStat<Resp>> {
    const { clock, crypto, transport } = this;
    const { endpoint, name } = apiCall;

    // Form request.
    const keys = await this.keys();
    const now = clock.now();
    const [authTS, statAuthTS] = await makeAuthTimestamp(keys, now, crypto);
    if (statAuthTS !== Status.Success) {
      return err(statAuthTS);
    }
    const enc = new Encoder();
    const encStatus = await endpoint.encodeReq(this, keys, authTS, items, enc);
    if (encStatus !== Status.Success) return err(encStatus);

    // Send request.
    const timeSent = clock.now();
    const [dec, statCall] = await transport.call(name, enc);
    const timeRcvd = clock.now();
    if (statCall !== Status.Success) {
      return err(statCall);
    }

    // Process response.
    const [head, statHead] = dec.readStruct(respHeadCodec);
    if (statHead !== Status.Success) {
      return err(statHead);
    }
    if (head.status !== Status.Success) {
      return err(head.status);
    }

    // Update host metadata based on response header.
    const clockOffset = offset(
      timeSent,
      head.timeRcvd,
      head.timeSent,
      timeRcvd,
    );
    const meta: IHostMetadata = {
      clockOffset,
      subscription: head.subscription,
    };
    const statMeta = await this.updateHostMeta(meta);
    if (statMeta !== Status.Success) {
      return err(statMeta);
    }

    // Return response.
    return endpoint.decodeResp(dec);
  }

  keys = (): Promise<HostSpecificKeyPair> => {
    const { host } = this;
    return hostKeys(this, host.label, host.idx);
  };

  seal = async (msg: IMessage): Promise<IBag> => {
    const { crypto, enclave } = this;
    const keys = await this.keys();
    const bag = await sealBag(msg, keys, crypto, enclave);
    return bag;
  };

  register = () => this.call(api.user, []);
  peek = (lastSeq: number) => this.call(api.peek, [lastSeq]);
  push = (bags: IBag[]) => this.call(api.push, bags);
  pull = (seqs: number[]) => this.call(api.pull, seqs);

  // listen for new bags.
  listen = async (recv: PushReceiver) => {
    const { clock, crypto, host, transport } = this;
    const { listener } = transport;
    const keys = await hostKeys(this, host.label, host.idx);
    const now = clock.now();
    const [authTS, statAuthTS] = await makeAuthTimestamp(keys, now, crypto);
    if (statAuthTS !== Status.Success) {
      return statAuthTS;
    }
    return await listener.connect(authTS, recv, () => {
      // TODO: handle disconnection, perhaps reconnect
      console.log("Disconnected from push listener");
    });
  };
}
