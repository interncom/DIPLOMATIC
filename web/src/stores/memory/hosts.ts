import { IHostConnectionInfo } from "../../shared/types";
import type { IHostRow, IHostStore } from "../../types";

export class MemoryHostStore implements IHostStore {
  hosts = new Map<string, IHostRow>();

  async init() { }

  async add(info: IHostConnectionInfo) {
    const host: IHostRow = {
      ...info,
      lastSyncedAt: new Date(0),
    };
    this.hosts.set(info.label, host);
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
