import { btoh, htob } from "../../shared/binary";
import { Hash } from "../../shared/types";
import { IUploadEntry, IUploadQueue } from "../../types";

export class MemoryUploadQueue implements IUploadQueue {
  /** host → (hashHex → bodyLen) */
  queue = new Map<string, Map<string, number>>();

  async enq(host: string, entries: Iterable<IUploadEntry>) {
    let map = this.queue.get(host);
    if (!map) {
      map = new Map();
      this.queue.set(host, map);
    }
    for (const e of entries) {
      map.set(btoh(e.hash), e.bodyLen);
    }
  }

  async deq(host: string, hshs: Iterable<Hash>) {
    const map = this.queue.get(host);
    if (map) {
      for (const hash of hshs) {
        map.delete(btoh(hash));
      }
    }
  }

  async list(host: string): Promise<IUploadEntry[]> {
    const map = this.queue.get(host);
    if (!map) return [];
    const out: IUploadEntry[] = [];
    for (const [hex, bodyLen] of map) {
      out.push({ hash: htob(hex) as Hash, bodyLen });
    }
    return out;
  }

  async count() {
    let total = 0;
    for (const map of this.queue.values()) {
      total += map.size;
    }
    return total;
  }

  async wipe() {
    this.queue.clear();
  }
}
