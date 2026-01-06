import libsodiumCrypto from "./crypto";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { EntityID, IHostConnectionInfo, IOp } from "./shared/types";
import { StateManager } from "./state";
import { IDiplomaticClientState, IDiplomaticClientXferState, IStore, IWebClient } from "./types";

export class NeoClient implements IWebClient {
  connections = new Map<string, DiplomaticClientAPI>();

  constructor(
    private clock: IClock,
    private state: StateManager,
    private store: IStore
  ) { }

  private async apply(op: IOp) {
    // TODO: implement.
  }

  public async upsert() { }
  public async delete(eid: EntityID) { }

  public async sync() {
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
    const { clock, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return;
    }
    const hosts = await store.hosts.list();
    for (const host of hosts) {
      const conn = new DiplomaticClientAPI(enclave, libsodiumCrypto, host, clock);
      await conn.register();
      this.connections.set(host.label, conn);
    }
  }
  
  public async disconnect() {
    this.connections.clear();
  }

  public async clientState(): Promise<IDiplomaticClientState> {
    const { store } = this;
    const enclave = await store.seed.load();
    const hosts = await store.hosts.list();
    return {
      hasSeed: enclave !== undefined,
      hasHost: Array.from(hosts).length > 0,
      connected: false, // TODO
    }
  }

  public async xferState(): Promise<IDiplomaticClientXferState> {
    const { uploads, downloads } = this.store;
    const numUploads = await uploads.count();
    const numDownloads = await downloads.count();
    return { numDownloads, numUploads };
  }

}

// Define client API
