import { Status } from "../../shared/consts";
import {
  HostHandle,
  IHostConnectionInfo,
  IHostMetadata,
} from "../../shared/types";
import type { IHostRow, IHostStore } from "../../types";

export class MemoryHostStore<Handle extends HostHandle>
  implements IHostStore<Handle> {
  hosts = new Map<string, IHostRow<Handle>>();

  async add(info: IHostConnectionInfo<Handle>) {
    const host: IHostRow<Handle> = {
      ...info,
      lastSeq: 0,
    };
    this.hosts.set(info.label, host);
  }

  // lastSeq only advances. Concurrent peek/push/notif must not regress the cursor.
  async touch(label: string, seq: number) {
    const host = this.hosts.get(label);
    if (!host || seq <= host.lastSeq) {
      return;
    }
    this.hosts.set(label, { ...host, lastSeq: seq });
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
