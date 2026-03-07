import { IDownloadMessage, IDownloadQueue } from "../../types";

function keyFor(host: string, seq: number): string {
  return `${host}:${seq}`;
}

export class MemoryDownloadQueue implements IDownloadQueue {
  queue = new Map<string, IDownloadMessage>();

  async enq(msgs: Iterable<IDownloadMessage>) {
    for (const msg of msgs) {
      const key = keyFor(msg.host, msg.seq);
      this.queue.set(key, msg);
    }
  }

  async deq(host: string, seqs: Iterable<number>) {
    for (const seq of seqs) {
      const key = keyFor(host, seq);
      this.queue.delete(key);
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
