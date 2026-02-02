import { Status } from "../../shared/consts";
import { HostHandle, IHostConnectionInfo, IHostMetadata } from "../../shared/types";
import type { IHostRow, IHostStore } from "../../types";

export class MemoryHostStore<Handle extends HostHandle>
  implements IHostStore<Handle> {
  hosts = new Map<string, IHostRow<Handle>>();

  async add(info: IHostConnectionInfo<Handle>) {
    const host: IHostRow<Handle> = {
      ...info,
      lastSyncedAt: new Date(0),
    };
    this.hosts.set(info.label, host);
  }

  async touch(label: string, now: Date) {
    const host = await this.get(label);
    if (!host) {
      return;
    }
    const next: IHostRow<Handle> = {
      ...host,
      lastSyncedAt: now,
    };
    this.hosts.set(label, next);
  }

  async get(label: string) {
    return this.hosts.get(label);
  }

  async set(label: string, meta: IHostMetadata) {
    const row = this.hosts.get(label);
    if (!row) {
      return Status.NotFound;
    }
    this.hosts.set(label, { ...row, ...meta });
    return Status.Success;
  }

  async del(label: string) {
    this.hosts.delete(label);
  }

  async list() {
    return this.hosts.values();
  }

  async wipe() {
    this.hosts.clear();
  }
}
