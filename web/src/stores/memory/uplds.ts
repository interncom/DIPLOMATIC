import { btoh, htob } from "../../shared/binary";
import { Hash } from "../../shared/types";
import { IUploadQueue } from "../../types";

export class MemoryUploadQueue implements IUploadQueue {
  queue = new Set<string>();

  async init() { }

  async enq(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      this.queue.add(btoh(hash));
    }
  }

  async deq(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      this.queue.delete(btoh(hash));
    }
  }

  async list() {
    const hshs: Hash[] = [];
    for (const hex of this.queue) {
      const hash = htob(hex) as Hash;
      hshs.push(hash);
    }
    return hshs;
  }

  async count() {
    return this.queue.size;
  }
}
