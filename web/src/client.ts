import { encode } from "@msgpack/msgpack";
import libsodiumCrypto from "./crypto";
import { StateEmitter } from "./events";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { Encoder } from "./shared/codec";
import { messageHeadCodec } from "./shared/codecs/messageHead";
import {
  EncodedMessage,
  genDeleteHead,
  genInsertHead,
  genUpsertHead,
  IMessageHead,
} from "./shared/message";
import {
  EntityID,
  HostHandle,
  ICrypto,
  IHostConnectionInfo,
  IInsertParams,
  ITransport,
  IUpsertParams,
} from "./shared/types";
import { syncPeek, syncPull, syncPush } from "./sync";
import {
  IClient,
  IDiplomaticClientState,
  IDiplomaticClientXferState,
  IStateEmitter,
  IStateManager,
  IStore,
  IStoredMessage,
} from "./types";

export class SyncClient<Handle extends HostHandle> implements IClient<Handle> {
  connections = new Map<string, DiplomaticClientAPI<Handle>>();

  public clientState: IStateEmitter<IDiplomaticClientState>;
  public xferState: IStateEmitter<IDiplomaticClientXferState>;

  constructor(
    private clock: IClock,
    private state: IStateManager,
    private store: IStore<Handle>,
    private transport: ITransport,
    private crypto: ICrypto = libsodiumCrypto,
  ) {
    this.clientState = new StateEmitter(() => this.getClientState());
    this.xferState = new StateEmitter(() => this.getXferState());
  }

  private async getClientState(): Promise<IDiplomaticClientState> {
    const { store } = this;
    const enclave = await store.seed.load();
    const hosts = await store.hosts.list();
    return {
      hasSeed: enclave !== undefined,
      hasHost: Array.from(hosts).length > 0,
      connected: false, // TODO
    };
  }

  private async getXferState(): Promise<IDiplomaticClientXferState> {
    const { uploads, downloads } = this.store;
    const numUploads = await uploads.count();
    const numDownloads = await downloads.count();
    return { numDownloads, numUploads };
  }

  private async apply(
    head: IMessageHead,
    body: EncodedMessage | undefined,
    upload = true,
  ) {
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, head);
    const headEnc = enc.result();
    const hash = await this.crypto.blake3(headEnc);
    const msg: IStoredMessage = { hash, head, body };

    // If message is being applied via sync, don't upload.
    if (upload) {
      // NOTE: important to enqueue upload before storing it.
      await this.store.uploads.enq([hash]);
    }

    await this.store.messages.add([msg]);

    // TODO: decide what should happen if there's an error while applying.
    // Dequeue upload and remove message?
    const stat = await this.state.apply({ ...head, bod: body });
    return stat;
  }

  public async insertRaw(body: EncodedMessage) {
    const clk = this.clock.now();
    const head = await genInsertHead(clk, body, this.crypto);
    return this.apply(head, body);
  }

  public async upsertRaw(eid: EntityID, body: EncodedMessage) {
    const clk = this.clock.now();
    const last = await this.store.messages.last(eid);
    const ctr = (last?.head.ctr ?? -1) + 1;
    const msg = await genUpsertHead(eid, clk, ctr, body, libsodiumCrypto);
    return this.apply(msg, body);
  }

  public async insert(op: IInsertParams) {
    const body = encode(op);
    return this.insertRaw(body);
  }

  public async upsert(op: IUpsertParams) {
    const { eid, ...rest } = op;
    const body = encode(rest);
    return this.upsertRaw(eid, body);
  }

  public async delete(eid: EntityID) {
    const clk = this.clock.now();
    const last = await this.store.messages.last(eid);
    const ctr = (last?.head.ctr ?? -1) + 1;
    const msg = genDeleteHead(eid, clk, ctr);
    return this.apply(msg, undefined);
  }

  public async sync() {
    const { clock, connections, crypto, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return;
    }

    for (const [label, conn] of connections) {
      const host = await store.hosts.get(label);
      if (!host) {
        continue;
      }
      await syncPeek(conn, store, enclave, clock, host, crypto);
      await syncPush(conn, store, enclave, clock, host, crypto);
      await syncPull(conn, store, enclave, host, crypto, this.apply.bind(this));
    }
  }

  public async wipe() {
    await this.disconnect();
    await this.store.wipe();
    this.clientState.emit();
    this.xferState.emit();
  }

  public async import(file: File) {
    // TODO: implement.
  }

  public async export(filename: string, extension?: string) {
    // TODO: implement.
  }

  // Manage stored host connections.
  public async link(host: IHostConnectionInfo<Handle>) {
    return this.store.hosts.add(host);
  }
  public async unlink(label: string) {
    return this.store.hosts.del(label);
  }

  // Manage active host connections.
  public async connect(listen = true) {
    const { clock, store, transport } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return;
    }
    const hosts = await store.hosts.list();
    for (const host of hosts) {
      const conn = new DiplomaticClientAPI(
        enclave,
        libsodiumCrypto,
        host,
        clock,
        transport,
      );
      await conn.register();
      if (listen) {
        const recv = (data: Uint8Array) => {
          this.sync().catch((err) => console.error("Sync failed:", err));
        };
        await conn.listen(recv);
      }
      this.connections.set(host.label, conn);
    }
  }

  public async disconnect() {
    this.connections.clear();
  }
}
