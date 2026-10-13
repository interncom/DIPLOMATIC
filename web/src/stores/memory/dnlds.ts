import type { IKDM } from "../../shared/codecs/kdm";
import { IDownloadMessage, IDownloadQueue } from "../../types";
import { type DownloadKey, downloadKey } from "../cursor";

export class MemoryDownloadQueue implements IDownloadQueue {
  queue = new Map<DownloadKey, IDownloadMessage>();

  async enq(msgs: Iterable<IDownloadMessage>) {
    for (const msg of msgs) {
      const key = downloadKey(msg.host, msg.seq, msg.realm);
      this.queue.set(key, msg);
    }
  }

  async deq(host: string, seqs: Iterable<number>, realm?: IKDM) {
    for (const seq of seqs) {
      this.queue.delete(downloadKey(host, seq, realm));
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
