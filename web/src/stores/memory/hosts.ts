import type { IHost, IHostStore } from "../../types";

export class MemoryHostStore implements IHostStore {
  hosts = new Map<string, IHost>();

  async init() { }

  async add(label: string, url: URL) {
    const host: IHost = {
      label,
      url,
      lastSyncedAt: new Date(0),
    };
    this.hosts.set(label, host);
  };

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
