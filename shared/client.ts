// DIPLOMATIC API client.

import { makeAuthTimestamp } from "./auth.ts";
import { sealBag } from "./bag.ts";
import { IClock, offset } from "./clock.ts";
import { Encoder } from "./codec.ts";
import { type IKDM, kdmEq } from "./codecs/kdm.ts";
import type { IBagPeekItem } from "./codecs/peekItem.ts";
import type { IBagPullItem } from "./codecs/pullItem.ts";
import { respHeadCodec } from "./codecs/respHead.ts";
import { APICallName, Status } from "./consts.ts";
import type { BagManager } from "./crypto/bagman.ts";
import type { Enclave } from "./crypto/enclave.ts";
import { type HostRlm, nullKDM } from "./crypto/derivation.ts";
import { IAuthenticatedEndpoint } from "./endpoint.ts";
import { api } from "./http.ts";
import type {
  HostHandle,
  IBag,
  ICrypto,
  IHostMetadata,
  IMessage,
  ITransport,
  PushReceiver,
} from "./types.ts";
import { err, ok, ValStat } from "./valstat.ts";

// One manager per realm for this identity. The default realm is nullKDM.
export async function hostBagMgrs(
  enclave: Enclave,
  idKDM: IKDM,
  realms: readonly IKDM[] = [nullKDM],
): Promise<ValStat<BagManager[]>> {
  const out: BagManager[] = [];
  for (const realm of realms) {
    const [bagMgr, st] = await enclave.bagman(idKDM, realm);
    if (st !== Status.Success) return err(st);
    out.push(bagMgr);
  }
  return ok(out);
}

export default class DiplomaticClientAPI<Handle extends HostHandle> {
  #bagMgrs: BagManager[];

  constructor(
    bagMgrs: BagManager[],
    public crypto: ICrypto,
    public clock: IClock,
    private transport: ITransport,
    private updateHostMeta: (meta: IHostMetadata) => Promise<Status>,
  ) {
    this.#bagMgrs = bagMgrs;
  }

  private async call<ReqInput, Resp>(
    apiCall: {
      endpoint: IAuthenticatedEndpoint<ReqInput, Resp>;
      name: APICallName;
    },
    body: ReqInput,
  ): Promise<ValStat<Resp>> {
    const { clock, transport } = this;
    const { endpoint, name } = apiCall;

    // Form request.
    const [id, ist] = await this.identity();
    if (ist !== Status.Success) return err(ist);
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
      body,
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

  // bagMgr for `realm` on this host. The default realm is nullKDM.
  bagMgrFor(realm: IKDM = nullKDM): BagManager | undefined {
    return this.#bagMgrs.find((bagMgr) => kdmEq(realm, bagMgr.realmKDM));
  }

  // bagMgrs this connection can seal and open.
  bagMgrs(): readonly BagManager[] {
    return this.#bagMgrs;
  }

  // Keeps `bagMgr` unless this realm is already present.
  add(bagMgr: BagManager): void {
    if (this.bagMgrFor(bagMgr.realmKDM) !== undefined) return;
    this.#bagMgrs.push(bagMgr);
  }

  // BagManager for this host. The null realm when present, otherwise any.
  identity = (): Promise<ValStat<BagManager>> => {
    const home = this.bagMgrFor(nullKDM) ?? this.#bagMgrs[0];
    if (home === undefined) return Promise.resolve(err(Status.NotFound));
    return Promise.resolve(ok(home));
  };

  // HostRLM for `realm` on this host. The default realm is nullKDM.
  hostRlm = (realm: IKDM = nullKDM): Promise<ValStat<HostRlm>> => {
    const bagMgr = this.bagMgrFor(realm);
    if (bagMgr === undefined) return Promise.resolve(err(Status.NotFound));
    return Promise.resolve(ok(bagMgr.rlm));
  };

  // Seals `msg` for `realm` on this host. The default realm is nullKDM.
  seal = async (
    msg: IMessage,
    realm: IKDM = nullKDM,
  ): Promise<ValStat<IBag>> => {
    const bagMgr = this.bagMgrFor(realm);
    if (bagMgr === undefined) return err(Status.NotFound);
    return sealBag(msg, bagMgr, this.crypto);
  };

  register = () => this.call(api.user, undefined);
  // Peeks `realm` after `lastSeq`. The default realm is nullKDM.
  peek = async (
    lastSeq: number,
    realm: IKDM = nullKDM,
  ): Promise<ValStat<IBagPeekItem[]>> => {
    const [rlm, st] = await this.hostRlm(realm);
    if (st !== Status.Success) return err(st);
    return this.call(api.peek, { rlm, seq: lastSeq });
  };
  push = (bags: IBag[]) => this.call(api.push, bags);
  // Pulls `seqs` from `realm`. The default realm is nullKDM.
  pull = async (
    seqs: number[],
    realm: IKDM = nullKDM,
  ): Promise<ValStat<IBagPullItem[]>> => {
    const [rlm, st] = await this.hostRlm(realm);
    if (st !== Status.Success) return err(st);
    return this.call(api.pull, { rlm, seqs });
  };

  // listen for new bags.
  listen = async (
    recv: PushReceiver,
    onDisconnect?: () => void,
    onConnect?: () => void,
  ) => {
    const { clock, transport } = this;
    const { listener } = transport;
    const [id, ist] = await this.identity();
    if (ist !== Status.Success) return ist;
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
