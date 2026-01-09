import { HostHandle, IHostConnectionInfo } from "../../shared/types";
import type { IHostRow, IHostStore } from "../../types";

export class MemoryHostStore<Handle extends HostHandle> implements IHostStore<Handle> {
  hosts = new Map<string, IHostRow<Handle>>();

  async init() { }

  async add(info: IHostConnectionInfo<Handle>) {
    const host: IHostRow<Handle> = {
      ...info,
      lastSyncedAt: new Date(0),
    };
    this.hosts.set(info.label, host);
  };

  async get(label: string) {
    return this.hosts.get(label);
  }

  async del(label: string) {
    this.hosts.delete(label);
  }

  async list() {
    return this.hosts.values();
  }

  async wipe() {
    this.hosts.clear();
  };
}
