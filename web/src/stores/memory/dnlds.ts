import { btoh } from "../../shared/binary";
import { Hash } from "../../shared/types";
import { IDownloadMessage, IDownloadQueue } from "../../types";

export class MemoryDownloadQueue implements IDownloadQueue {
  queue = new Map<string, IDownloadMessage>();

  async init() { }

  async enq(msgs: Iterable<IDownloadMessage>) {
    for (const msg of msgs) {
      this.queue.set(btoh(msg.hash), msg);
    }
  }

  async deq(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      this.queue.delete(btoh(hash));
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
}
