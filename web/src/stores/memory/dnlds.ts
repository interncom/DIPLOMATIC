import { btoh } from "../../shared/binary";
import { Hash } from "../../shared/types";
import { IDownloadMessage, IDownloadQueue } from "../../types";

export class MemoryDownloadQueue implements IDownloadQueue {
  queue = new Map<string, IDownloadMessage>();

  async enq(msgs: Iterable<IDownloadMessage>) {
    for (const msg of msgs) {
      const hex = btoh(msg.hash);
      this.queue.set(hex, msg);
    }
  }

  async deq(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      const hex = btoh(hash);
      this.queue.delete(hex);
    }
  }

  async list() {
    const msgs: IDownloadMessage[] = [];
    for (const msg of this.queue.values()) {
      msgs.push(msg);
    }
    return msgs;
  }

  async count() {
    return this.queue.size;
  }

  async wipe() {
    this.queue.clear();
  }
}
