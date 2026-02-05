import { btoh, htob } from "../../shared/binary";
import { Hash } from "../../shared/types";
import { IUploadQueue } from "../../types";

export class MemoryUploadQueue implements IUploadQueue {
  queue = new Map<string, Set<string>>();

  async enq(host: string, hshs: Iterable<Hash>) {
    const set = this.queue.get(host) || new Set();
    this.queue.set(host, set);
    for (const hash of hshs) {
      set.add(btoh(hash));
    }
  }

  async deq(host: string, hshs: Iterable<Hash>) {
    const set = this.queue.get(host);
    if (set) {
      for (const hash of hshs) {
        set.delete(btoh(hash));
      }
    }
  }

  async list(host: string) {
    const set = this.queue.get(host);
    if (!set) return [];
    const hshs: Hash[] = [];
    for (const hex of set) {
      hshs.push(htob(hex) as Hash);
    }
    return hshs;
  }

  async count() {
    let total = 0;
    for (const set of this.queue.values()) {
      total += set.size;
    }
    return total;
  }

  async wipe() {
    this.queue.clear();
  }
}
