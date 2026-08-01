// DIPLOMATIC API client.

import { makeAuthTimestamp } from "./auth.ts";
import { sealBag } from "./bag.ts";
import { IClock, offset } from "./clock.ts";
import { Encoder } from "./codec.ts";
import { respHeadCodec } from "./codecs/respHead.ts";
import { APICallName, Status } from "./consts.ts";
import { Enclave, type Identity } from "./enclave.ts";
import { IAuthenticatedEndpoint } from "./endpoint.ts";
import { api } from "./http.ts";
import type {
  HostHandle,
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
  ) {}

  private async call<ReqItem, Resp>(
    apiCall: {
      endpoint: IAuthenticatedEndpoint<ReqItem, Resp>;
      name: APICallName;
    },
    items: Iterable<ReqItem>,
  ): Promise<ValStat<Resp>> {
    const { clock, transport } = this;
    const { endpoint, name } = apiCall;

    // Form request.
    const id = await this.identity();
    const now = clock.now();
    const [authTS, statAuthTS] = await makeAuthTimestamp(id, now);
    if (statAuthTS !== Status.Success) {
      return err(statAuthTS);
    }
    const enc = new Encoder();
    const encStatus = await endpoint.encodeReq(
      this,
      id,
      authTS,
      items,
      enc,
    );
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
    const respVS = endpoint.decodeResp(dec);
    return respVS;
  }

  identity = (): Promise<Identity> => {
    const { host, enclave } = this;
    return enclave.deriveIdentity(host.label, host.idx ?? 0);
  };

  seal = async (msg: IMessage): Promise<ValStat<IBag>> => {
    const { crypto, enclave } = this;
    const id = await this.identity();
    return sealBag(msg, id, crypto, enclave);
  };

  register = () => this.call(api.user, []);
  peek = (lastSeq: number) => this.call(api.peek, [lastSeq]);
  push = (bags: IBag[]) => this.call(api.push, bags);
  pull = (seqs: number[]) => this.call(api.pull, seqs);

  // listen for new bags.
  listen = async (
    recv: PushReceiver,
    onDisconnect?: () => void,
    onConnect?: () => void,
  ) => {
    const { clock, transport } = this;
    const { listener } = transport;
    const id = await this.identity();
    const now = clock.now();
    const [authTS, statAuthTS] = await makeAuthTimestamp(id, now);
    if (statAuthTS !== Status.Success) {
      return statAuthTS;
    }
    return await listener.connect(authTS, recv, onDisconnect, onConnect);
  };

  /** Returns whether this client has an active connection to its host.
   * If a push listener is active, reports the listener's connected state.
   * Otherwise (listen=false), reports true if registered.
   */
  isConnected(): boolean {
    const listener = this.transport?.listener;
    if (listener && typeof listener.connected === "function") {
      return listener.connected();
    }
    return true;
  }

  /** Close the push listener (e.g. websocket) if present. Used for cleanup
   * of stale connections before reconnecting after backgrounding etc.
   */
  closeListener() {
    this.transport?.listener?.disconnect();
  }
}
