import libsodiumCrypto from "./crypto";
import { StateEmitter } from "./events";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { Encoder } from "./shared/codec";
import { messageHeadCodec } from "./shared/codecs/messageHead";
import { EncodedMessage, genDeleteHead, genInsertHead, genUpsertHead, IMessageHead } from "./shared/message";
import { EntityID, HostHandle, IHostConnectionInfo, ITransport } from "./shared/types";
import { StateManager } from "./state";
import { syncConnection, syncPeek, syncPull, syncPush } from "./sync";
import { IClient, IDiplomaticClientState, IDiplomaticClientXferState, IStateEmitter, IStore, IStoredMessage } from "./types";

export class NeoClient<Handle extends HostHandle> implements IClient<Handle> {
  connections = new Map<string, DiplomaticClientAPI<Handle>>();

  public clientState: IStateEmitter<IDiplomaticClientState>;
  public xferState: IStateEmitter<IDiplomaticClientXferState>;

  constructor(
    private clock: IClock,
    private state: StateManager,
    private store: IStore<Handle>,
    private transport: ITransport,
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
    }
  }

  private async getXferState(): Promise<IDiplomaticClientXferState> {
    const { uploads, downloads } = this.store;
    const numUploads = await uploads.count();
    const numDownloads = await downloads.count();
    return { numDownloads, numUploads };
  }

  private async apply(head: IMessageHead, body?: EncodedMessage) {
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, head);
    const headEnc = enc.result();
    const hash = await libsodiumCrypto.blake3(headEnc);
    const msg: IStoredMessage = { hash, head, body };
    // NOTE: important to enqueue upload before storing it.
    await this.store.uploads.enq([hash]);
    await this.store.messages.add([msg]);
  }

  public async insert(body: EncodedMessage) {
    const clk = this.clock.now();
    const head = await genInsertHead(clk, body, libsodiumCrypto);
    await this.apply(head, body);
  }

  public async upsert(eid: EntityID, body: EncodedMessage) {
    const clk = this.clock.now();
    const last = await this.store.messages.last(eid);
    const ctr = (last?.head.ctr ?? -1) + 1;
    const msg = await genUpsertHead(eid, clk, ctr, body, libsodiumCrypto);
    await this.apply(msg, body);
  }

  public async delete(eid: EntityID) {
    const clk = this.clock.now();
    const last = await this.store.messages.last(eid);
    const ctr = (last?.head.ctr ?? -1) + 1;
    const msg = genDeleteHead(eid, clk, ctr);
    await this.apply(msg);
  }

  public async sync() {
    const { clock, connections, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return;
    }

    for (const [label, conn] of connections) {
      const host = await store.hosts.get(label);
      if (!host) {
        continue;
      }
      await syncPeek(conn, store, enclave, host);
      await syncPush(conn, store);
      await syncPull(conn, store, enclave, host);
    }
  }

  public async wipe() {
    // TODO: implement (with precautions).
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
      const conn = new DiplomaticClientAPI(enclave, libsodiumCrypto, host, clock, transport);
      await conn.register();
      if (listen) {
        const recv = (data: Uint8Array) => {
          this.sync().catch(err => console.error('Sync failed:', err));
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
