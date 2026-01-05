import { Hash } from "../../shared/types";
import { IUploadQueue } from "../../types";

export class MemoryUploadQueue implements IUploadQueue {
  queue = new Set<Hash>();

  async init() { }

  async enq(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      this.queue.add(hash);
    }
  }

  async deq(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      this.queue.delete(hash);
    }
  }

  async list() {
    return this.queue;
  }

  async count() {
    return this.queue.size;
  }
}
