import { Status } from "../../shared/consts";
import {
  HostHandle,
  IHostConnectionInfo,
  IHostMetadata,
} from "../../shared/types";
import type { HostStatsUpdate, IHostRow, IHostStore } from "../../types";

function applyStats<H extends HostHandle>(
  host: IHostRow<H>,
  u: HostStatsUpdate,
): void {
  if (u.setLastSeq !== undefined) {
    host.lastSeq = u.setLastSeq;
  } else if (u.lastSeq !== undefined && u.lastSeq > host.lastSeq) {
    host.lastSeq = u.lastSeq;
  }
}

export class MemoryHostStore<Handle extends HostHandle>
  implements IHostStore<Handle> {
  hosts = new Map<string, IHostRow<Handle>>();

  /**
   * Upsert connection info. Same label + same handle/idx keeps lastSeq and
   * host meta (safe re-link). Changing handle/idx resets the peek cursor.
   */
  async add(info: IHostConnectionInfo<Handle>) {
    const prev = this.hosts.get(info.label);
    const same = prev !== undefined &&
      prev.handle === info.handle &&
      (prev.idx ?? 0) === (info.idx ?? 0);
    const host: IHostRow<Handle> = {
      ...info,
      lastSeq: same ? prev.lastSeq : 0,
      clockOffset: same ? prev.clockOffset : undefined,
      subscription: same ? prev.subscription : undefined,
    };
    this.hosts.set(info.label, host);
  }

  // lastSeq only advances. Concurrent peek/push/notif must not regress the cursor.
  async touch(label: string, seq: number) {
    await this.recordStats(label, { lastSeq: seq });
  }

  async recordStats(label: string, u: HostStatsUpdate) {
    const host = this.hosts.get(label);
    if (!host) return;
    applyStats(host, u);
    this.hosts.set(label, { ...host });
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
