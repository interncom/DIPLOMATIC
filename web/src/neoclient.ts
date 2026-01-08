import libsodiumCrypto from "./crypto";
import { StateEmitter } from "./events";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { EntityID, HostHandle, IHostConnectionInfo, IOp, ITransport } from "./shared/types";
import { StateManager } from "./state";
import { IDiplomaticClientState, IDiplomaticClientXferState, IStateEmitter, IStore, IWebClient as IClient } from "./types";

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

  private async apply(op: IOp) {
    // TODO: implement. op type may be wrong.
  }
  public async upsert() {
    // TODO: implement.
  }
  public async delete(eid: EntityID) {
    // TODO: implement.
  }

  public async sync() {
    // TODO: implement.
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
  public async link(host: IHostConnectionInfo) {
    return this.store.hosts.add(host);
  }
  public async unlink(label: string) {
    return this.store.hosts.del(label);
  }

  // Manage active host connections.
  public async connect() {
    const { clock, store, transport } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return;
    }
    const hosts = await store.hosts.list();
    for (const host of hosts) {
      const conn = new DiplomaticClientAPI(enclave, libsodiumCrypto, host, clock, transport);
      await conn.register();
      this.connections.set(host.label, conn);
    }
  }

  public async disconnect() {
    this.connections.clear();
  }
}
